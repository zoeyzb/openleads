"""Offline regression checks for direct directory discovery and resumption."""
import tempfile
import unittest
from pathlib import Path

from law_local.source_discovery import crawl_direct, source_url
from law_local.worker import SqliteQueue

PROFILE = """<h1>800-620-0900</h1><h1>Resources</h1>
<h1>Cox &amp; Stauffer</h1><p>Firm Size: 2-3 lawyers</p>
<p>Call 404-424-1900</p>"""

class DirectSourceTests(unittest.TestCase):
    def test_source_url_restricts_to_directory(self):
        self.assertEqual(source_url("/firm/cox-stauffer.html",
              "https://www.lawyer.com/", "GA")[1], "firm")
        self.assertEqual(source_url("/ocala-lawyer-fl.htm",
              "https://www.lawyer.com/florida-lawyer.htm", "FL")[1], "city")
        for url in ("https://example.com/firm/evil.html",
                    "javascript:alert(1)", "mailto:x@y.com"):
            self.assertEqual(source_url(url,"https://www.lawyer.com/","FL")[0], "")

    def test_fetches_real_shaped_profile_but_does_not_qualify_it(self):
        with tempfile.TemporaryDirectory() as folder:
            db=SqliteQueue(Path(folder)/"state.sqlite3")
            calls=[]
            def fetch(url,timeout=9):
                calls.append(url)
                return ("<html>"+PROFILE+"<div>Published law directory contact and firm size</div></html>") if url.endswith("/firm/cox-stauffer.html") else "<html><body>no directory listings, no profile links</body></html>"
            stats=crawl_direct(db,fetch_fn=fetch,seconds=30,max_pages=17,delay=0)
            self.assertGreaterEqual(stats["profiles_parsed"],1)
            self.assertGreaterEqual(stats["candidates_added"],1)
            self.assertEqual(db.counts().get("calling_qualified"),0)
            second=crawl_direct(db,fetch_fn=fetch,seconds=30,max_pages=17,delay=0)
            self.assertEqual(second["candidates_added"],0)
            db.close()

if __name__=="__main__":
    unittest.main()
