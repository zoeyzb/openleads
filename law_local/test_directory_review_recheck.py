"""Safely revisit website holds caused exclusively by independently identified directories."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from law_local.worker import SqliteQueue, run_batch, utc_now

LEAD=dict(firm="Example & Partner Law PLLC", phone="3124221836",
          state="IL",city="Chicago",source_url="https://www.lawyer.com/firm/example-partner-law.html")

def old_review(urls):
    return dict(status="review_website",firm=LEAD["firm"],phone=LEAD["phone"],
                site_status="review_website",checked_at=utc_now(),
                site_evidence={"reason":"possible_owned_site","status":"review_website","urls":urls,
                   "providers":[{"provider":"searxng:yandex","responded":True,"urls":urls},
                                {"provider":"searxng:yep","responded":True,"urls":[]}]})

def cleared():
    return dict(status="strict_eligible",firm=LEAD["firm"],phone=LEAD["phone"],
                source_url=LEAD["source_url"],checked_at=utc_now(),
                site_status="screened_no_site",qualification_scope="law_no_owned_website_email",
                email="office@gmail.com",email_source=LEAD["source_url"],email_mx_ok=True,
                site_evidence={"providers":[{"provider":"searxng:yandex","responded":True,"urls":[]},
                                           {"provider":"searxng:yep","responded":True,"urls":[]}],
                               "checked_at":utc_now()})

class DirectoryOnlyWebsiteHoldTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.q=SqliteQueue(Path(self.temp.name)/"test.db")
        self.q.add(LEAD)
    def tearDown(self):
        self.q.close()
        self.temp.cleanup()
    def status(self):
        return self.q.conn.execute("select status from candidates").fetchone()[0]
    def test_directory_only_review_is_retryable_and_promoted_by_fresh_completed_checks(self):
        self.q.record(LEAD,old_review(["https://lawful.com/lawyers/example-partner",
                                       "https://www.lawyer.com/firm/example.html"]))
        self.assertEqual(self.q.pending(1)[0]["firm"],LEAD["firm"])
        with patch("law_local.worker.process_candidate",return_value=cleared()):
            counts=run_batch(self.q,1,1,20,site_search_usable=True)
        self.assertEqual(counts["strict_eligible"],1)
        self.assertEqual(self.q.counts()["strict_eligible"],1)
        self.assertGreaterEqual(self.q.conn.execute("select count(*) from candidate_check_history").fetchone()[0],2)
    def test_legacy_review_with_stored_directory_url_rechecks_from_scratch(self):
        old=old_review(["https://lawful.com/lawyers/example"])
        # Older results stored the observed URL but not separate providers.
        old["site_evidence"]["providers"]=[]
        self.q.record(LEAD,old)
        self.assertEqual(self.q.pending(2)[0]["status"],"review_website")
        with patch("law_local.worker.process_candidate",return_value=cleared()):
            result=run_batch(self.q,1,1,20,site_search_usable=True)
        self.assertEqual(result.get("strict_eligible"),1)

    def test_unknown_or_possible_owned_website_can_never_auto_clear(self):
        self.q.record(LEAD,old_review(["https://lawful.com/lawyers/example",
                                       "https://example-partner-law.com/"]))
        self.assertFalse(self.q.review_only_directories(old_review([
            "https://lawful.com/lawyers/example", "https://example-partner-law.com/"])))
        self.assertEqual(self.q.pending(5),[])
        r=cleared();r["review_method"]="automated_directory_only_recheck"
        self.q.record(LEAD,r)
        self.assertEqual(self.status(),"review_website")
    def test_direct_source_website_hint_never_auto_clear(self):
        prior=old_review(["https://lawful.com/lawyers/example"])
        prior["website_candidates"]=["https://example-partner-law.com/"]
        self.q.record(LEAD,prior)
        self.assertEqual(self.q.pending(5),[])
    def test_fresh_nonprivate_identity_revokes_historic_site_hold(self):
        original=old_review(["https://lawful.com/lawyers/example"])
        self.q.record(LEAD,original)
        incoming={"status":"review_nonlaw_employer","checked_at":utc_now(),
                  "reason":"Verified source is government employer",
                  "review_method":"automated_directory_only_recheck"}
        self.q.record(LEAD,incoming)
        self.assertEqual(self.status(),"review_nonlaw_employer")

    def test_failed_retry_preserves_hold_and_enforces_cooldown(self):
        prior=old_review(["https://lawful.com/lawyers/example"])
        self.q.record(LEAD,prior)
        with patch("law_local.worker.process_candidate",return_value={"status":"inconclusive","reason":"timeout"}):
            out=run_batch(self.q,1,1,20,site_search_usable=True)
        self.assertEqual(out["inconclusive"],1)
        self.assertEqual(self.status(),"review_website")
        self.assertEqual(self.q.pending(1),[])
    def test_never_retry_after_published_owned_site(self):
        prior=old_review(["https://lawful.com/lawyers/example"])
        prior["site_status"]="published_owned_website"
        self.q.record(LEAD,prior)
        self.assertEqual(self.q.pending(1),[])

if __name__=="__main__":unittest.main()
