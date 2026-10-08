"""Only actual indexed third-party source URLs are accepted."""
import unittest
from law_local.search_sources import parse_bing_rss,permitted_source,real_profile_urls,source_queries

REAL_FIRM="https://www.lawyer.com/firm/riverbank-and-grove-law.html"
BAR="https://www.floridabar.org/directories/find-mbr/profile/?num=366780"
XML="""<?xml version='1.0'?><rss version='2.0'><channel>
<item><title>A</title><link>https://www.lawyer.com/firm/riverbank-and-grove-law.html</link></item>
<item><title>B</title><link>https://www.floridabar.org/directories/find-mbr/profile/?num=366780</link></item>
<item><title>C</title><link>https://riverbankexample.com</link></item>
</channel></rss>"""

class RealSourceSearchTests(unittest.TestCase):
    def test_actual_result_links_not_guessed_or_owned_sites(self):
        self.assertEqual(parse_bing_rss(XML),[REAL_FIRM,BAR])
        self.assertIsNone(parse_bing_rss("<html>Verify you're a human</html>"))
        self.assertFalse(permitted_source("https://www.lawyer.com/firm/guessed"))
        self.assertFalse(permitted_source("https://www.lawyers.com/rockford/illinois/guessed-900-f/"))
        self.assertFalse(permitted_source("https://attacker.com/firm/riverbank-and-grove-law.html"))

    def test_search_queries_are_bounded_and_firm_specific(self):
        a=source_queries("Riverbank & Grove Law","Rockford","IL")
        self.assertEqual(len(a),2)
        self.assertTrue(all('"Riverbank & Grove Law"' in x for x in a))
        b=source_queries("Culmer & Davidson","Rockledge","FL")
        self.assertEqual(len(b),3)
        self.assertIn("site:floridabar.org",b[0])

    def test_search_empty_and_provider_failures_not_evidence(self):
        result=real_profile_urls("Riverbank & Grove Law","Rockford","IL",
            fetch_fn=lambda url,timeout=8:XML)
        self.assertEqual(result["urls"],[REAL_FIRM,BAR])
        self.assertEqual(result["responded"],2)
        self.assertEqual(result["queries"],2)
        blocked=real_profile_urls("Riverbank & Grove Law","Rockford","IL",
            fetch_fn=lambda url,timeout=8: (_ for _ in ()).throw(ValueError("HTTP 403")))
        self.assertEqual(blocked["responded"],0)
        self.assertEqual(blocked["urls"],[])
