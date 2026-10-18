"""Offline evidence tests for the truly key-free official OSM map fallback."""
import asyncio
import importlib.util
import tempfile
import unittest
from pathlib import Path

HERE=Path(__file__).parent/'harvey_sidecar.py'
SPEC=importlib.util.spec_from_file_location('harvey_sidecar_test',HERE)
sidecar=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(sidecar)

XML=b'''<?xml version="1.0"?><osm version="0.6" generator="official-osm-api">
<node id="123" lat="41.877" lon="-87.629">
  <tag k="name" v="Parker &amp; Co Law"/>
  <tag k="office" v="lawyer"/>
  <tag k="contact:phone" v="+1-312-422-1836"/>
</node>
<node id="124" lat="41.878" lon="-87.630">
  <tag k="name" v="Firm Owns Its Website"/>
  <tag k="office" v="lawyer"/>
  <tag k="phone" v="312-222-1111"/>
  <tag k="contact:website" v="https://owned-site.example/"/>
</node>
<way id="555">
  <tag k="name" v="Two Partner Law LLP"/>
  <tag k="office" v="lawyer"/>
  <tag k="phone" v="312-222-1200"/>
  <tag k="website" v="https://twopartner.example"/>
</way>
<node id="125"><tag k="name" v="Other Office"/><tag k="office" v="accountant"/></node>
<node id="abc"><tag k="name" v="Corrupt OSM ID"/><tag k="office" v="lawyer"/></node>
</osm>'''


class FreeOSMFallbackTests(unittest.TestCase):
    def test_official_xml_only_lawyers_with_precise_source(self):
        rows=sidecar.parse_osm_map_xml(XML,'Chicago','IL',10)
        self.assertEqual(len(rows),3)
        self.assertEqual(rows[0]['external_id'],'osm:node/123')
        self.assertEqual(rows[0]['source_url'],'https://www.openstreetmap.org/node/123')
        self.assertEqual(rows[0]['phone'],'+1-312-422-1836')
        self.assertFalse(rows[0]['has_website'])
        self.assertTrue(rows[1]['has_website'])
        self.assertEqual(rows[1]['website'],'https://owned-site.example/')
        self.assertEqual(rows[2]['external_id'],'osm:way/555')
        self.assertEqual(rows[2]['category'],'lawyer')
    def test_result_cap_does_not_fabricate_firmwide_count(self):
        rows=sidecar.parse_osm_map_xml(XML,'Chicago','IL',1)
        self.assertEqual(len(rows),1)
        self.assertNotIn('attorneys',rows[0])
        self.assertNotIn('strict_eligible',rows[0])
    def test_xml_outage_or_invalid_payload_cannot_count_empty(self):
        for content in (b'gateway error',b'<html></html>',b''):
            with self.subTest(content=content), self.assertRaises((ValueError,Exception)):
                sidecar.parse_osm_map_xml(content,'Chicago','IL',10)
    def test_large_download_is_rejected(self):
        with self.assertRaises(ValueError):
            sidecar.parse_osm_map_xml(b'x'*12_000_001,'Chicago','IL',10)

class OfficialBBoxContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_single_small_bbox_no_api_key(self):
        class Response:
            status_code=200
            def raise_for_status(self):pass
            async def aiter_bytes(self):
                yield XML[:20]
                yield XML[20:]
            async def __aenter__(self):return self
            async def __aexit__(self,*args):pass
        class Client:
            def __init__(self):self.calls=[]
            def stream(self,method,url,**kwargs):
                self.calls.append((method,url,kwargs))
                return Response()
        class Args:
            lat=41.8781;lon=-87.6298;city='Chicago';state='IL';limit=5
        client=Client()
        rows=await sidecar.official_osm_bbox(client,Args())
        self.assertEqual(len(rows),3)
        self.assertEqual(len(client.calls),1)
        method,url,kw=client.calls[0]
        self.assertEqual(method,'GET')
        self.assertEqual(url,'https://api.openstreetmap.org/api/0.6/map')
        self.assertNotIn('key',str(kw).lower())
        area=list(map(float,kw['params']['bbox'].split(',')))
        self.assertAlmostEqual(area[2]-area[0],0.01)
        self.assertAlmostEqual(area[3]-area[1],0.01)
    async def test_stream_over_limit_does_not_create_businesses(self):
        class Response:
            def raise_for_status(self):pass
            async def aiter_bytes(self):
                yield b'x'*12_000_001
            async def __aenter__(self):return self
            async def __aexit__(self,*args):pass
        class Client:
            def stream(self,*args,**kwargs):return Response()
        class Args:
            lat=41.8781;lon=-87.6298;city='Chicago';state='IL';limit=5
        with self.assertRaises(ValueError):
            await sidecar.official_osm_bbox(Client(),Args())

if __name__=='__main__':unittest.main()
