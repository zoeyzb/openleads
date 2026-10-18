"""Offline discovery tests: no source page or provider hit is fabricated."""
import tempfile
import unittest
from pathlib import Path
from law_local.worker import (
    SqliteQueue, discovery_queries, _extract_directory_profile,
    discover_candidates, _discovery_result_url, _search_directory_profiles,
)

PROFILE = """<html><h1>Keystone & Parker Law Group</h1>
<p>Call (312) 422-1836</p><p>Firm Size: 4</p></html>"""
URL = "https://www.lawyer.com/firm/keystone-parker-law-group.html"


class DiscoveryTests(unittest.TestCase):
    def test_state_queries_are_diverse_and_reject_unknown_states(self):
        queries=list(discovery_queries(["IL", "CA"]))
        self.assertEqual(len(queries), 16)
        self.assertEqual(queries[0][0], "IL")
        self.assertNotEqual(queries[0][1], queries[1][1])
        with self.assertRaises(ValueError):
            list(discovery_queries(["XX"]))

    def test_directory_result_variations(self):
        url="https://www.lawyer.com/firm/sample-firm.html"
        alt="https://www.lawyer.com/firms/example-firm.html"
        self.assertEqual(_discovery_result_url(url),url)
        self.assertEqual(_discovery_result_url(alt),alt)
        self.assertEqual(_discovery_result_url("//www.lawyer.com/firm/sample-firm.html"),url)
        self.assertEqual(_discovery_result_url("https://example.com/firm/sample-firm.html"),"")
        self.assertEqual(_discovery_result_url("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.lawyer.com%2Ffirm%2Fsample-firm.html"),url)

    def test_source_profile_requires_published_size_and_phone(self):
        record=_extract_directory_profile(URL, PROFILE)
        self.assertEqual(record["firm"], "Keystone & Parker Law Group")
        self.assertEqual(record["phone"], "3124221836")
        self.assertIsNone(_extract_directory_profile(URL, PROFILE.replace("Firm Size: 4", "Client: 4")))
        self.assertIsNone(_extract_directory_profile(URL, PROFILE.replace("(312) 422-1836","")))
        self.assertIsNone(_extract_directory_profile(URL, PROFILE.replace("Firm Size: 4","Firm Size: 1")))

    def test_real_directory_shape_selects_firm_not_banner(self):
        html="""<h1>800-620-0900</h1><h1>Resources</h1>
        <h1>Keystone & Parker Law Group</h1>
        <h2>Keystone & Parker Law Group</h2>
        <p>Firm Size: 2 - 5 attorneys</p><p>Call 312-422-1836</p>
        <footer>Call Us 800-620-0900</footer>"""
        record=_extract_directory_profile(URL,html)
        self.assertEqual(record["firm"],"Keystone & Parker Law Group")
        self.assertEqual(record["phone"],"3124221836")
        from law_local.worker import evaluate_published_source
        evidence=evaluate_published_source(html,record)
        self.assertEqual(evidence["attorneys"],2)
        self.assertEqual(evidence["attorney_range"],(2,5))

    def test_broad_firm_size_range_is_not_verified_2_to_10(self):
        html="""<h1>Keystone & Parker Law Group</h1>
        <p>Firm Size: 1 - 5 attorneys</p><p>Call 312-422-1836</p>"""
        self.assertIsNone(_extract_directory_profile(URL,html))
        self.assertIsNone(_extract_directory_profile(URL,html.replace("1 - 5","9 - 20")))

    def test_resume_query_checkpoint_and_dedupe(self):
        with tempfile.TemporaryDirectory() as folder:
            db=SqliteQueue(Path(folder)/"law.sqlite3")
            queries=[]
            def search(query):
                queries.append(query)
                return [URL,URL]
            def fetch(url,timeout=10):
                self.assertEqual(url,URL)
                return PROFILE
            first=discover_candidates(db,["IL"],max_queries=1,max_pages=20,
                                      seconds=30,delay=0,search_fn=search,fetch_fn=fetch)
            self.assertEqual(first["candidates_added"],1)
            second=discover_candidates(db,["IL"],max_queries=1,max_pages=20,
                                       seconds=30,delay=0,search_fn=search,fetch_fn=fetch)
            self.assertEqual(second["candidates_added"],0)
            self.assertNotEqual(queries[0],queries[1])
            self.assertEqual(db.counts()["pending"],1)
            db.close()

    def test_search_failure_not_checkpointed(self):
        with tempfile.TemporaryDirectory() as folder:
            db=SqliteQueue(Path(folder)/"law.sqlite3")
            def failed(query):
                raise TimeoutError("Bing unavailable")
            first=discover_candidates(db,["FL"],max_queries=1,max_pages=1,
                                      seconds=2,delay=0,search_fn=failed)
            self.assertGreater(first["provider_failures"],0)
            self.assertEqual(db.conn.execute("SELECT COUNT(*) FROM discovery_queries").fetchone()[0],0)
            db.close()


if __name__ == "__main__":
    unittest.main()
