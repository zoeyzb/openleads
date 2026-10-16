import sqlite3
import tempfile
import unittest
from pathlib import Path
from ops.local_law.test_screen_maps_websites import GOOD
from ops.local_law.screen_maps_websites import screen

class MapsOwnedEvidenceTests(unittest.TestCase):
    def test_owned_evidence_prevents_rescreening(self):
        with tempfile.TemporaryDirectory() as d:
            from ops.local_law.test_screen_maps_websites import MapSiteScreeningTests
            db=MapSiteScreeningTests().seed(d)
            catalog=Path(d)/'research_catalog.sqlite3'
            with sqlite3.connect(db) as q:
                mid=q.execute('SELECT map_id FROM maps_raw_candidates').fetchone()[0]
            with sqlite3.connect(catalog) as c:
                c.execute('CREATE TABLE external_evidence(lead_id TEXT,kind TEXT,proof_url TEXT,note TEXT,verified_at TEXT)')
                c.execute('INSERT INTO external_evidence VALUES(?,?,?,?,?)',('maps:'+mid.lower(),'owned_website','https://example.org','confirmed','2026-10-16T00:00:00Z'))
            result=screen(db,5,search=lambda *_:GOOD,health_ok=True,research_path=catalog)
            self.assertEqual(result['attempted'],0)
            self.assertEqual(result['calling_qualified_total'],0)

if __name__=='__main__':
    unittest.main()
