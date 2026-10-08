"""Census identifies *why* legacy contacts fail without qualifying them."""
import unittest
from law_local.source_census import raw_source_signals

URL="https://www.lawyer.com/firm/example.html"
LEAD={"firm":"Parker & Stevens Law","phone":"(312) 555-9211","source_url":URL}
HTML="""<html><h1>Parker & Stevens Law</h1><section><h3>Firm Size: 2-5 Attorneys</h3>
<p>Call (312) 555-9211</p>
<a href="https://parkerstevenslaw.example">Visit Site</a></section>
<p>other attorney contact jane@example.net</p></html>"""

class CensusTests(unittest.TestCase):
    def test_real_source_can_be_mapped_to_identity_phone_headcount_owned_link(self):
        s=raw_source_signals(HTML,LEAD)
        self.assertTrue(s["name_match"])
        self.assertTrue(s["phone_match"])
        self.assertTrue(s["explicit_size"])
        self.assertEqual(s["size_range"],[2,5])
        self.assertEqual(s["owned_site_hints"],1)
    def test_phone_mismatch_explains_identity_failure_without_claiming_eligibility(self):
        s=raw_source_signals(HTML,{**LEAD,"phone":"(312) 555-8812"})
        self.assertTrue(s["name_match"])
        self.assertFalse(s["phone_match"])
        self.assertTrue(s["explicit_size"])
    def test_range_one_to_ten_rejected(self):
        s=raw_source_signals(HTML.replace("2-5","1-10"),LEAD)
        self.assertFalse(s["explicit_size"])
    def test_unrelated_heading_does_not_match_firm(self):
        s=raw_source_signals(HTML,{**LEAD,"firm":"Elsewhere, LLC"})
        self.assertFalse(s["name_match"])
