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

    def test_ambiguous_owned_evidence_never_promotes_even_if_search_healthy(self):
        from ops.local_law.test_screen_maps_websites import MapSiteScreeningTests
        for kind in ('possible_owned_website','owned_website_candidate'):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as d:
                db=MapSiteScreeningTests().seed(d)
                catalog=Path(d)/'research_catalog.sqlite3'
                with sqlite3.connect(db) as q:
                    mid=q.execute('SELECT map_id FROM maps_raw_candidates').fetchone()[0]
                with sqlite3.connect(catalog) as c:
                    c.execute('CREATE TABLE external_evidence(lead_id TEXT,kind TEXT,proof_url TEXT,note TEXT,verified_at TEXT)')
                    c.execute('INSERT INTO external_evidence VALUES(?,?,?,?,?)',('maps:'+mid.lower(),kind,'https://possibly-owned.example','identity unresolved','2026-10-16T00:00:00Z'))
                result=screen(db,5,search=lambda *_:GOOD,health_ok=True,research_path=catalog)
                self.assertEqual(result['attempted'],0)
                self.assertEqual(result['calling_qualified_total'],0)

    def test_manual_followup_does_not_auto_clear_on_old_check(self):
        from ops.local_law.test_screen_maps_websites import MapSiteScreeningTests
        with tempfile.TemporaryDirectory() as d:
            db=MapSiteScreeningTests().seed(d)
            with sqlite3.connect(db) as q:
                mid=q.execute('SELECT map_id FROM maps_raw_candidates').fetchone()[0]
                q.execute('CREATE TABLE maps_website_checks(map_id TEXT PRIMARY KEY,checked_at TEXT,status TEXT,result_json TEXT)')
                q.execute('INSERT INTO maps_website_checks VALUES(?,?,?,?)',
                          (mid,'2000-01-01T00:00:00Z','manual_followup_required','{}'))
            result=screen(db,5,search=lambda *_:GOOD,health_ok=True)
            self.assertEqual(result['attempted'],0)
            self.assertEqual(result['calling_qualified_total'],0)

if __name__=='__main__':
    unittest.main()
