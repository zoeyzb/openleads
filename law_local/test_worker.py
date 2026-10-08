import unittest
from law_local.worker import (
    normalize_phone, evaluate_published_source, classify_search_results,
    evaluate_candidate, firm_identity_matches, SqliteQueue, import_csv, run_batch
)
import tempfile
from unittest.mock import patch
import csv
from pathlib import Path

PROFILE = """
<html><h1>Keystone & Parker Law Group</h1>
<p>Call (312) 422-1836</p>
<p>Keystone & Parker Law Group has 4 attorneys at this location.</p>
<p>Contact: intake@keystoneparker.testing-law.org</p></html>
"""
LEAD = {
    "firm": "Keystone & Parker Law Group",
    "phone": "(312) 422-1836",
    "city": "Chicago", "state": "IL",
    "source_url": "https://www.lawyers.com/chicago/illinois/keystone-parker-law-group/"
}

class QualityTests(unittest.TestCase):
    def test_phone(self):
        self.assertEqual(normalize_phone("+1 (312) 422-1836"), "3124221836")
        self.assertEqual(normalize_phone("111-111-1111"), "")
        self.assertEqual(normalize_phone("000-000-0000"), "")
        self.assertEqual(normalize_phone("312-555-0182"), "")

    def test_firm_identity_requires_name_and_phone(self):
        self.assertTrue(firm_identity_matches(PROFILE, LEAD))
        self.assertFalse(firm_identity_matches(PROFILE.replace("422-1836","422-1111"), LEAD))
        self.assertFalse(firm_identity_matches(PROFILE.replace("Keystone & Parker","Someone Else"), LEAD))

    def test_headcount_and_email_are_attested_by_same_page(self):
        result=evaluate_published_source(PROFILE, LEAD)
        self.assertEqual(result["attorneys"],4)
        self.assertEqual(result["emails"],["intake@keystoneparker.testing-law.org"])
        self.assertFalse(result["website_candidates"])

    def test_explicit_directory_firm_size_field(self):
        html=PROFILE.replace("Keystone & Parker Law Group has 4 attorneys at this location.","Firm Size: 4")
        self.assertEqual(evaluate_published_source(html,LEAD)["attorneys"],4)

    def test_directory_footer_email_is_not_a_firm_email(self):
        html=PROFILE.replace("intake@keystoneparker.testing-law.org",
                             "support@corp.lawyer.com")
        result=evaluate_published_source(html,LEAD)
        self.assertEqual(result["emails"],[])

    def test_relative_visit_site_link_requires_manual_review(self):
        html=PROFILE.replace("</html>","<a href='/out?firm=123'>Visit Site</a></html>")
        result=evaluate_candidate(LEAD,html,[
            {"responded":True,"urls":[]},{"responded":True,"urls":[]}
        ],mx_check=lambda domain:True)
        self.assertEqual(result["status"],"review_website")
        self.assertTrue(result["website_candidates"])

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

    def test_firm_owned_source_page_cannot_be_no_site(self):
        lead={**LEAD,"source_url":"https://keystoneparker.testing-law.org/about"}
        verdict=evaluate_candidate(lead,PROFILE,[
            {"responded":True,"urls":[]},{"responded":True,"urls":[]}
        ],mx_check=lambda domain:True)
        self.assertEqual(verdict["status"],"owned_site_or_untrusted_source")

    def test_strict_gate_never_guesses_an_email(self):
        result=evaluate_candidate(LEAD, PROFILE.replace("intake@keystoneparker.testing-law.org",""),
                                  [{"responded":True,"urls":[]},{"responded":True,"urls":[]}],
                                  mx_check=lambda domain:True)
        self.assertEqual(result["status"],"strict_eligible")
        self.assertEqual(result["email"],"")

    def test_strict_gate_requires_mx_and_two_no_site_checks(self):
        good=evaluate_candidate(LEAD,PROFILE,[{"responded":True,"urls":[]},{"responded":True,"urls":[]}],
                                mx_check=lambda domain:True)
        self.assertEqual(good["status"],"strict_eligible")
        bad=evaluate_candidate(LEAD,PROFILE,[{"responded":True,"urls":[]},{"responded":True,"urls":[]}],
                               mx_check=lambda domain:False)
        self.assertEqual(bad["status"],"strict_eligible")
        self.assertEqual(bad["email"],"")

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

    def test_legacy_no_email_records_are_requeued(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/"law.sqlite3"
            db=SqliteQueue(path)
            db.add(LEAD)
            db.record(LEAD,{"status":"call_ready_no_email","attorneys":4})
            db.close()
            db=SqliteQueue(path)
            self.assertEqual(db.counts()["pending"],1)
            db.close()

class EndToEndTests(unittest.TestCase):
    def test_outage_is_not_retried_three_times_in_one_run(self):
        with tempfile.TemporaryDirectory() as folder:
            db=SqliteQueue(Path(folder)/"law.sqlite3")
            self.assertTrue(db.add(LEAD))
            with patch("law_local.worker.fetch_public",side_effect=TimeoutError("source timeout")):
                result=run_batch(db,max_rows=5,workers=1,seconds=10)
            self.assertEqual(result,{"inconclusive":1})
            self.assertEqual(db.conn.execute("SELECT attempts FROM candidates").fetchone()[0],1)
            db.close()

    def test_import_process_export_source_provenance(self):
        with tempfile.TemporaryDirectory() as folder:
            db=SqliteQueue(Path(folder)/"law.sqlite3")
            path=Path(folder)/"seeds.csv"
            with path.open("w",newline="",encoding="utf-8") as file:
                w=csv.DictWriter(file,fieldnames=["firm","phone","city","state","source_url"])
                w.writeheader()
                w.writerow(LEAD)
            self.assertEqual(import_csv(db,path),1)
            with patch("law_local.worker.fetch_public",return_value=PROFILE), \
                 patch("law_local.worker.search_for_firm",return_value=[
                     {"responded":True,"urls":[]},{"responded":True,"urls":[]}
                 ]), \
                 patch("law_local.worker.domain_has_mail",return_value=True):
                result=run_batch(db,max_rows=1,workers=1,seconds=10)
            self.assertEqual(result,{"strict_eligible":1})
            output=Path(folder)/"strict.csv"
            self.assertEqual(db.export("strict_eligible",output),1)
            with output.open(newline="",encoding="utf-8") as file:
                rows=list(csv.DictReader(file))
            self.assertEqual(rows[0]["Headcount source"],LEAD["source_url"])
            self.assertEqual(rows[0]["Email source"],LEAD["source_url"])
            self.assertEqual(rows[0]["Website audit"],"screened_no_site")
            self.assertEqual(db.counts()["strict_eligible"],1)
            db.close()

if __name__=="__main__":
    unittest.main()
