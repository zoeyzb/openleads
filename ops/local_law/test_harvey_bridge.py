"""Strict Harvey boundary: source-only research, no fabricated qualifications."""
import json
import sqlite3
import subprocess
import tempfile
import unittest
from datetime import datetime,timezone
from pathlib import Path
from unittest.mock import patch

from law_local.worker import SqliteQueue, utc_now
from ops.local_law import harvey_bridge as bridge


class HarveyResearchBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        self.research=self.root/'research.sqlite3'
        self.queue=self.root/'leads.sqlite3'
        self.vendor=self.root/'fake-vendor'
        (self.vendor/'.venv/bin').mkdir(parents=True)
        (self.vendor/'.venv/bin/python').write_text('fixture')
    def tearDown(self):self.temp.cleanup()

    def fake_osm(self, args, **kwargs):
        self.assertEqual(kwargs['vendor'],self.vendor)
        return {'provider':'harvey:osm','strict_qualified_added':0,
                'rows':[
                    {'name':'Parker & Quinn Law','phone':'3124221836',
                     'category':'lawyer','website':'','has_website':False,
                     'source_url':'https://www.openstreetmap.org/node/123',
                     'external_id':'osm:node/123'},
                    {'name':'Real Website Law','phone':'3124221826',
                     'category':'lawyer','website':'https://realwebsite.example',
                     'has_website':True,'source_url':'https://www.openstreetmap.org/way/456',
                     'external_id':'osm:way/456'},
                    {'name':'Invalid Place','phone':'3124221876','category':'lawyer',
                     'website':'','has_website':False,'source_url':'http://127.0.0.1/node/7',
                     'external_id':'osm:node/7'},
                    {'name':'No Phone','phone':'','category':'lawyer',
                     'website':'','has_website':False,'source_url':'https://www.openstreetmap.org/node/789',
                     'external_id':'osm:node/789'},
                ]}

    def test_osm_research_only_and_existing_unverified_pool(self):
        now=datetime(2026,10,19,tzinfo=timezone.utc)
        report=bridge.discover_osm('chicago',self.research,self.queue,self.vendor,
                                   runner=self.fake_osm,now=now)
        self.assertEqual(report['discovered_with_valid_law_phone'],2)
        self.assertEqual(report['new_unverified_map_research'],1)
        self.assertEqual(report['source_has_website'],1)
        self.assertEqual(report['strict_qualified_created'],0)
        db=sqlite3.connect(self.queue)
        self.assertEqual(db.execute('SELECT status FROM maps_raw_candidates').fetchone()[0],
                         'unverified_headcount')
        self.assertEqual(db.execute("SELECT COUNT(*) FROM sqlite_master WHERE name='candidates'").fetchone()[0],0)
        db.close()
        research=sqlite3.connect(self.research)
        self.assertEqual(research.execute('SELECT COUNT(*) FROM harvey_osm_research').fetchone()[0],2)
        self.assertEqual(research.execute("SELECT COUNT(*) FROM harvey_osm_research WHERE disposition='listed_website_hold'").fetchone()[0],1)
        research.close()
        again=bridge.discover_osm('chicago',self.research,self.queue,self.vendor,
                                  runner=lambda *a,**kw: (_ for _ in ()).throw(AssertionError('repeat network')),
                                  now=now)
        self.assertTrue(again['skipped_recent'])
    def test_later_missing_website_tag_cannot_erase_prior_positive_website(self):
        now=datetime(2026,10,19,tzinfo=timezone.utc)
        initial=bridge.discover_osm('chicago',self.research,self.queue,self.vendor,
                                    runner=self.fake_osm,now=now)
        self.assertEqual(initial['source_has_website'],1)
        def missing_tags(*args,**kwargs):
            data=self.fake_osm(*args,**kwargs)
            data['rows']=[dict(data['rows'][1],website='',has_website=False)]
            return data
        later=bridge.discover_osm('chicago',self.research,self.queue,self.vendor,
                                  runner=missing_tags,now=now,force=True)
        self.assertEqual(later['new_unverified_map_research'],0)
        c=sqlite3.connect(self.research)
        self.assertEqual(c.execute("SELECT disposition FROM harvey_osm_research WHERE external_id='osm:way/456'").fetchone()[0],
                         'listed_website_hold')
        c.close()

    def test_error_does_not_turn_outage_into_empty_business_market(self):
        report=bridge.discover_osm('miami',self.research,self.queue,self.vendor,
                runner=lambda *a,**kw: (_ for _ in ()).throw(TimeoutError('overpass timeout')))
        self.assertEqual(report['error'],'TimeoutError')
        self.assertEqual(report['strict_qualified_created'],0)
        self.assertEqual(sqlite3.connect(self.research).execute("SELECT status FROM harvey_osm_runs").fetchone()[0], 'failed')
    def test_failed_free_source_has_daily_backoff_and_never_fake_zero(self):
        attempt=datetime(2026,10,19,tzinfo=timezone.utc)
        fired=[]
        def failed(*a,**kw):
            fired.append(1)
            raise TimeoutError('upstream OSM server outage')
        first=bridge.discover_osm('miami',self.research,self.queue,self.vendor,
                runner=failed,now=attempt)
        self.assertEqual(first['error'],'TimeoutError')
        self.assertEqual(first['strict_qualified_created'],0)
        second=bridge.discover_osm('miami',self.research,self.queue,self.vendor,
                runner=failed,now=attempt)
        self.assertEqual(second['reason'],'provider_cooldown')
        self.assertEqual(len(fired),1)
        self.assertFalse(second['city_coverage_complete'])

    def test_successful_micro_sample_does_not_claim_a_city_was_covered(self):
        data=bridge.discover_osm('chicago',self.research,self.queue,self.vendor,
                                 runner=self.fake_osm)
        self.assertFalse(data['city_coverage_complete'])
        self.assertEqual(data['geography_scope'],'one_small_map_bbox')
        self.assertEqual(data['strict_qualified_created'],0)

    def test_no_arbitrary_source_url_or_false_blank_field(self):
        self.assertTrue(bridge._validate_osm_source('https://www.openstreetmap.org/node/55'))
        for url in ('https://example.com/node/55','http://127.0.0.1/node/55',
                    'https://www.openstreetmap.org/node/not-real',
                    'https://www.openstreetmap.org.evil.test/node/55'):
            self.assertFalse(bridge._validate_osm_source(url))
    def test_bad_city_and_batch_size_rejected(self):
        with self.assertRaises(ValueError):bridge.discover_osm('random',self.research,self.queue,self.vendor)
        with self.assertRaises(ValueError):bridge.discover_osm('chicago',self.research,self.queue,self.vendor,limit=10000)

    def test_strict_sync_exports_only_current_proven_email_and_headcount(self):
        q=SqliteQueue(self.queue)
        try:
            lead={'firm':'Parker & Quinn Law','phone':'3124221836',
                  'state':'IL','city':'Chicago','source_url':'https://www.lawyers.com/firm/parker'}
            q.add(lead)
            proof={'status':'strict_eligible','site_status':'screened_no_site','phone':'3124221836',
                   'attorneys':3,'headcount_source':lead['source_url'],
                   'email':'intake@parkerquinn.example-law.org',
                   'email_source':lead['source_url'],'checked_at':utc_now(),
                   'qualification_scope':'law_no_owned_website_2_10_email',
                   'site_evidence':{'providers':[{'responded':True,'urls':['https://www.lawyers.com/firm/parker']},
                                                 {'responded':True,'urls':['https://www.avvo.com/example']}]}}
            q.record(lead,proof)
            legacy={'firm':'Old One-Lawyer Law','phone':'3124221876','city':'Chicago','state':'IL',
                   'source_url':'https://www.lawyers.com/firm/old'}
            q.add(legacy)
            q.record(legacy,{**proof,'status':'call_qualified_no_email','email':'','attorneys':1})
        finally:q.close()
        def fake_runner(args,**kwargs):
            rows=kwargs['payload']['strict_firms']
            self.assertEqual(len(rows),1)
            self.assertEqual(rows[0]['attorneys'],3)
            self.assertEqual(rows[0]['firm'],'Parker & Quinn Law')
            return {'strict_companies':1,'prospects_created':0,'outbound_enabled':False}
        report=bridge.sync_verified(self.queue,self.vendor,runner=fake_runner)
        self.assertEqual(report['verified_firms_from_openleads'],1)
        self.assertEqual(report['prospects_created'],0)
    def test_sidecar_contract_cannot_claim_outbound_is_enabled(self):
        q=SqliteQueue(self.queue);q.close()
        with self.assertRaises(RuntimeError):
            bridge.sync_verified(self.queue,self.vendor,runner=lambda *a,**kw:{
                'strict_companies':0,'prospects_created':0,'outbound_enabled':True})
    def test_sanitized_environment_retains_no_api_keys(self):
        with patch.dict('os.environ',{'OPENAI_API_KEY':'secret','ABC_API_TOKEN':'secret',
                                     'CODEX_HOME':'/tmp/wrong','PATH':'/bin'}):
            sanitized=bridge._environment(self.vendor)
        self.assertNotIn('OPENAI_API_KEY',sanitized)
        self.assertNotIn('ABC_API_TOKEN',sanitized)
        self.assertNotIn('CODEX_HOME',sanitized)
        self.assertIn('node_modules/.bin',sanitized['PATH'])
    def test_real_isolated_harvey_company_mirror_never_creates_outbound(self):
        vendor=bridge.VENDOR
        if not (vendor/'.venv/bin/python').is_file():
            self.skipTest('local Harvey vendor not installed')
        target=self.root/'private-harvey.sqlite3'
        sample={'id':'openleads:strict:integration7','firm':'Test Firm & Partner',
                'phone':'3124221836','city':'Chicago','state':'IL',
                'source_url':'https://lawyers.com/example','email':'office@fixture.example',
                'attorneys':3,'headcount_source':'https://lawyers.com/example',
                'email_source':'https://lawyers.com/example',
                'site_status':'screened_no_site','status':'strict_eligible',
                'checked_at':'2026-10-19T00:00:00+00:00'}
        cmd=bridge._sidecar_command('sync-strict',vendor)+['--db',str(target)]
        for firms,created,withdrawn in [([sample],1,0),([sample],0,0),([],0,1)]:
            p=subprocess.run(cmd,input=json.dumps({'strict_firms':firms}),text=True,
                             capture_output=True,cwd=vendor,env=bridge._environment(vendor),timeout=30)
            self.assertEqual(p.returncode,0,p.stderr[-550:])
            report=json.loads(p.stdout.strip())
            self.assertEqual(report['companies_created'],created)
            self.assertEqual(report['companies_withdrawn'],withdrawn)
            self.assertFalse(report['outbound_enabled'])
            self.assertEqual(report['prospects_created'],0)
        c=sqlite3.connect(target)
        self.assertEqual(c.execute('select count(*) from companies').fetchone()[0],1)
        self.assertEqual(c.execute("select source from companies").fetchone()[0],'openleads:withdrawn')
        self.assertEqual(c.execute('select count(*) from prospects').fetchone()[0],0)
        self.assertEqual(c.execute('select count(*) from campaigns').fetchone()[0],0)
        self.assertEqual(c.execute('select count(*) from outbox').fetchone()[0],0)
        self.assertEqual(target.stat().st_mode & 0o777,0o600)
        c.close()

    def test_login_doctor_never_exposes_tokens(self):
        (self.vendor/'.venv/bin/harvey').write_text('fixture')
        (self.vendor/'.harvey-codex-cli/node_modules/.bin').mkdir(parents=True)
        (self.vendor/'.harvey-codex-cli/node_modules/.bin/codex').write_text('fixture')
        fake=lambda *a,**kw: subprocess.CompletedProcess(a[0],1,
             'Codex NOT READY: Your Codex login has expired or is due for renewal.','topsecret token')
        status=bridge.doctor(self.vendor,runner=fake)
        self.assertFalse(status['codex_connected'])
        self.assertNotIn('topsecret',str(status))

if __name__=='__main__':unittest.main()
