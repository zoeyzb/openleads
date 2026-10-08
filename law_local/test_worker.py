import unittest
from law_local.worker import (
    normalize_phone, evaluate_published_source, classify_search_results,
    evaluate_candidate, firm_identity_matches, SqliteQueue
)
import tempfile
from pathlib import Path

PROFILE = """
<html><h1>Keystone & Parker Law Group</h1>
<p>Call (312) 555-0182</p>
<p>Keystone & Parker Law Group has 4 attorneys at this location.</p>
<p>Contact: intake@keystoneparker.testing-law.org</p></html>
"""
LEAD = {
    "firm": "Keystone & Parker Law Group",
    "phone": "(312) 555-0182",
    "city": "Chicago", "state": "IL",
    "source_url": "https://www.lawyers.com/chicago/illinois/keystone-parker-law-group/"
}

class QualityTests(unittest.TestCase):
    def test_phone(self):
        self.assertEqual(normalize_phone("+1 (312) 555-0182"), "3125550182")
        self.assertEqual(normalize_phone("111-111-1111"), "")
        self.assertEqual(normalize_phone("000-000-0000"), "")

    def test_firm_identity_requires_name_and_phone(self):
        self.assertTrue(firm_identity_matches(PROFILE, LEAD))
        self.assertFalse(firm_identity_matches(PROFILE.replace("555-0182","555-0111"), LEAD))
        self.assertFalse(firm_identity_matches(PROFILE.replace("Keystone & Parker","Someone Else"), LEAD))

    def test_headcount_and_email_are_attested_by_same_page(self):
        result=evaluate_published_source(PROFILE, LEAD)
        self.assertEqual(result["attorneys"],4)
        self.assertEqual(result["emails"],["intake@keystoneparker.testing-law.org"])
        self.assertFalse(result["website_candidates"])

    def test_reject_unattributed_headcount(self):
        html=PROFILE.replace("Keystone & Parker Law Group has 4 attorneys at this location.","4 attorneys for defendant.")
        self.assertEqual(evaluate_published_source(html,LEAD)["attorneys"],0)

    def test_search_outage_does_not_certify_absence(self):
        found=classify_search_results([{"responded":False,"urls":[]},{"responded":True,"urls":[]}])
        self.assertEqual(found["status"],"inconclusive")

    def test_two_clean_search_responses_support_bounded_audit(self):
        found=classify_search_results([{"responded":True,"urls":["https://www.lawyers.com/profile"]},{"responded":True,"urls":["https://www.justia.com/attorneys"]}])
        self.assertEqual(found["status"],"screened_no_site")

    def test_possible_firm_site_must_be_reviewed(self):
        found=classify_search_results([{"responded":True,"urls":["https://keystoneparker.testing-law.org"]},{"responded":True,"urls":[]}])
        self.assertEqual(found["status"],"review_website")

    def test_ddg_redirect_cannot_hide_possible_owned_website(self):
        found=classify_search_results([
            {"responded":True,"urls":["https://duckduckgo.com/l/?uddg=https%3A%2F%2Fkeystoneparker.testing-law.org"]},
            {"responded":True,"urls":[]}
        ])
        self.assertEqual(found["status"],"review_website")

    def test_missing_bing_source_does_not_make_verified(self):
        found=classify_search_results([
            {"responded":False,"urls":[]},
            {"responded":True,"urls":[]}
        ])
        self.assertNotEqual(found["status"],"screened_no_site")

    def test_strict_gate_never_guesses_an_email(self):
        result=evaluate_candidate(LEAD, PROFILE.replace("intake@keystoneparker.testing-law.org",""),
                                  [{"responded":True,"urls":[]},{"responded":True,"urls":[]}],
                                  mx_check=lambda domain:True)
        self.assertEqual(result["status"],"call_ready_no_email")

    def test_strict_gate_requires_mx_and_two_no_site_checks(self):
        good=evaluate_candidate(LEAD,PROFILE,[{"responded":True,"urls":[]},{"responded":True,"urls":[]}],
                                mx_check=lambda domain:True)
        self.assertEqual(good["status"],"strict_eligible")
        bad=evaluate_candidate(LEAD,PROFILE,[{"responded":True,"urls":[]},{"responded":True,"urls":[]}],
                               mx_check=lambda domain:False)
        self.assertNotEqual(bad["status"],"strict_eligible")

    def test_queue_persists_and_deduplicates(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/"law.sqlite3"
            db=SqliteQueue(path)
            self.assertTrue(db.add(LEAD))
            self.assertFalse(db.add(LEAD))
            self.assertEqual(len(db.pending(10)),1)
            db.record(LEAD,{"status":"strict_eligible","attorneys":4,"email":"intake@keystoneparker.testing-law.org"})
            db.close()
            db=SqliteQueue(path)
            self.assertEqual(len(db.pending(10)),0)
            self.assertEqual(db.counts()["strict_eligible"],1)
            db.close()

if __name__=="__main__":
    unittest.main()
