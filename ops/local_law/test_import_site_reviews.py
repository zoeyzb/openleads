import copy,tempfile,unittest
from pathlib import Path
from law_local.worker import SqliteQueue,utc_now
from ops.local_law.import_site_reviews import import_reviews,validate

def fixture():
    now=utc_now()
    return {"lead":{"firm":"Example Private Law","phone":"3124221836","state":"IL","city":"Chicago","source_url":"https://www.lawyer.com/firm/example-private-law.html"},
        "identity_text":"Example Private Law Call 312-422-1836",
        "private_practice_confirmed":True,"checked_at":now,"reviewer":"unit-test-only",
        "notes":"Fixture only; never production.",
        "providers":[{"provider":name,"responded":True,"query":"Example Private Law Chicago 3124221836",
            "checked_at":now,"results":[{"url":"https://www.lawyer.com/firm/example-private-law.html",
            "relevant":True,"disposition":"directory","note":"Matching directory profile"}],
            "positive_control":{"query":"known law website","expected_domain":"example.org","urls":["https://example.org/"],"checked_at":now}}
            for name in ("test-one","test-two")]}

class ReviewTests(unittest.TestCase):
    def test_import_replay_and_fresh_export(self):
        with tempfile.TemporaryDirectory() as d:
            db=Path(d)/"q.db";review=fixture()
            self.assertEqual(import_reviews(db,[review])["new_verified"],1)
            self.assertEqual(import_reviews(db,[review])["replayed"],1)
            q=SqliteQueue(db)
            self.assertEqual(q.export("calling_qualified",Path(d)/"calls.csv"),1)
            self.assertEqual(q.conn.execute("SELECT status FROM candidates").fetchone()[0],"call_qualified_no_email")
            self.assertEqual(q.conn.execute("select count(*) from operator_site_reviews").fetchone()[0],1)
            q.close()
    def test_missing_and_unhealthy_control_rejected(self):
        for field,value in (("urls",[]),("checked_at","2000-01-01T00:00:00+00:00")):
            r=fixture();r["providers"][1]["positive_control"][field]=value
            with self.assertRaises(ValueError): validate(r)
    def test_duplicate_provider_rejected(self):
        r=fixture();r["providers"][1]["provider"]=r["providers"][0]["provider"]
        with self.assertRaises(ValueError):validate(r)
    def test_unmatched_phone_rejected(self):
        r=fixture();r["identity_text"]="Example Private Law Call 312-422-9999"
        with self.assertRaises(ValueError):validate(r)
    def test_outage_and_irrelevant_results_rejected(self):
        for change in ("outage","irrelevant"):
            r=fixture()
            if change=="outage":r["providers"][1]["responded"]=False
            else:r["providers"][1]["results"][0]["relevant"]=False
            with self.assertRaises(ValueError):validate(r)
    def test_owned_or_hosted_uncertain_site_never_qualifies(self):
        for status in ("owned","uncertain"):
            with tempfile.TemporaryDirectory() as d:
                r=fixture();r["providers"][0]["results"][0]["disposition"]=status
                result=import_reviews(Path(d)/"q.db",[r])
                self.assertEqual(result["calling_qualified_total"],0)
    def test_whole_batch_validated_before_mutation(self):
        with tempfile.TemporaryDirectory() as d:
            db=Path(d)/"q.db";bad=fixture();bad["checked_at"]="old"
            with self.assertRaises(ValueError):import_reviews(db,[fixture(),bad])
            self.assertFalse(db.exists())
    def test_confirmed_owned_evidence_supersedes_unresolved_hold(self):
        with tempfile.TemporaryDirectory() as d:
            db=Path(d)/"q.db";r=fixture();q=SqliteQueue(db);q.add(r["lead"])
            u="https://unrelated.example/"
            q.record(r["lead"],{"status":"review_website","site_evidence":{"urls":[u]}})
            q.record(r["lead"],{"status":"review_website","site_status":"published_owned_website","owned_site_url":"https://confirmed.example/"})
            import json
            self.assertEqual(json.loads(q.conn.execute("SELECT result_json FROM candidates").fetchone()[0])["owned_site_url"],"https://confirmed.example/")
            q.close()
            r["providers"][0]["results"].append({"url":u,"relevant":False,"disposition":"unrelated","note":"Different identity."})
            with self.assertRaisesRegex(ValueError,"owned-site evidence"):
                import_reviews(db,[r])

    def test_operator_can_clear_only_explicitly_reviewed_prior_candidates(self):
        with tempfile.TemporaryDirectory() as d:
            db=Path(d)/"q.db";r=fixture();q=SqliteQueue(db)
            q.add(r["lead"])
            prior_url="https://different-practice.example/"
            q.record(r["lead"],{"status":"review_website","site_evidence":{"urls":[prior_url]}})
            q.close()
            with self.assertRaisesRegex(ValueError,"unresolved website candidates"):
                import_reviews(db,[r])
            q=SqliteQueue(db)
            self.assertEqual(q.conn.execute("SELECT COUNT(*) FROM operator_site_reviews").fetchone()[0],0)
            q.close()
            r["providers"][0]["results"].append({"url":prior_url,"relevant":False,"disposition":"unrelated","note":"Inspected different location, principal and phone."})
            self.assertEqual(import_reviews(db,[r])["new_verified"],1)

    def test_existing_candidate_is_promoted(self):
        with tempfile.TemporaryDirectory() as d:
            db=Path(d)/"q.db";r=fixture();q=SqliteQueue(db)
            q.add(r["lead"]);q.close()
            self.assertEqual(import_reviews(db,[r])["new_verified"],1)
    def test_public_client_publication_survives_export_only_with_complete_review(self):
        with tempfile.TemporaryDirectory() as d:
            db=Path(d)/"q.db";r=fixture()
            r["lead"]["source_url"]="https://client-publication.example/auction-brochure"
            self.assertEqual(import_reviews(db,[r])["new_verified"],1)
            q=SqliteQueue(db)
            self.assertEqual(q.export("calling_qualified",Path(d)/"calls.csv"),1)
            row=q.conn.execute("SELECT * FROM candidates").fetchone()
            import json
            evidence=json.loads(row["result_json"])
            for defect in ("missing_review","wrong_phone","owned_link"):
                bad=copy.deepcopy(evidence)
                if defect=="missing_review":bad.pop("operator_review")
                elif defect=="wrong_phone":bad["operator_review"]["lead"]["phone"]="3124229999"
                else:bad["operator_review"]["providers"][0]["results"][0]["disposition"]="owned"
                self.assertFalse(q._verified_for_export(row,bad,"strict_eligible"))
            q.close()
    def test_new_or_replayed_no_site_review_cannot_requalify_inactive_practice(self):
        with tempfile.TemporaryDirectory() as d:
            db=Path(d)/"q.db";r=fixture()
            import_reviews(db,[r])
            q=SqliteQueue(db)
            q.record(r["lead"],{"status":"rejected_inactive","eligibility_hold":{
                "reason":"retired","source_url":"https://registry.example/retired"}})
            q.close()
            self.assertEqual(import_reviews(db,[r])["replayed"],1)
            new=copy.deepcopy(r);new["notes"]="New dated review of website absence only"
            with self.assertRaisesRegex(ValueError,"inactive-practice hold"):
                import_reviews(db,[new])
            q=SqliteQueue(db)
            self.assertEqual(q.export("calling_qualified",Path(d)/"calls.csv"),0)
            self.assertEqual(q.conn.execute("SELECT status FROM candidates").fetchone()[0],"rejected_inactive")
            q.close()
if __name__=="__main__":unittest.main()

class ScopedSourceReviewTests(unittest.TestCase):
    def test_monitor_source_proof_survives_operator_review_and_export(self):
        from datetime import datetime,timezone
        from law_local.test_flbar_monitor import MonitorTests
        sample=MonitorTests();sample.setUp()
        review=fixture();review['lead']=sample.lead
        for provider,name in zip(review['providers'],('searxng:google cse','searxng:yep')):provider['provider']=name
        review['identity_text']=sample.raw.replace('18 Oct 2026',datetime.now(timezone.utc).strftime('%d %b %Y'))
        with tempfile.TemporaryDirectory() as d:
            db=Path(d)/'q.db'
            self.assertEqual(import_reviews(db,[review])['new_verified'],1)
            q=SqliteQueue(db)
            self.assertEqual(q.export('calling_qualified',Path(d)/'calls.csv'),1)
            import json
            row=q.conn.execute('SELECT * FROM candidates').fetchone()
            proof=json.loads(row['result_json'])
            self.assertTrue(proof['fl_private_contact']['private_practice_confirmed'])
            proof['fl_private_contact']['phone']='8505669319'
            self.assertFalse(q._verified_for_export(row,proof,row['status']))
            q.close()

    def test_monitor_source_website_hint_cannot_be_cleared_by_review_assertion(self):
        from datetime import datetime,timezone
        from law_local.test_flbar_monitor import MonitorTests
        sample=MonitorTests();sample.setUp()
        review=fixture();review['lead']=sample.lead
        for provider,name in zip(review['providers'],('searxng:google cse','searxng:yep')):provider['provider']=name
        review['identity_text']=sample.raw.replace('18 Oct 2026',datetime.now(timezone.utc).strftime('%d %b %Y')).replace('<dd>—</dd>','<dd>https://uncertain.example</dd>')
        with self.assertRaisesRegex(ValueError,'website hint'):
            validate(review)

class SupplementalReviewTests(unittest.TestCase):
    def test_supplemental_urls_resolve_holds_without_fabricated_index_attribution(self):
        with tempfile.TemporaryDirectory() as d:
            db=Path(d)/'q.db';review=fixture();q=SqliteQueue(db);q.add(review['lead'])
            url='https://publication.example/legal-notice'
            q.record(review['lead'],{'status':'review_website','site_evidence':{'urls':[url]}});q.close()
            review['supplemental_results']=[dict(url=url,disposition='unrelated',note='Third party newspaper publisher, not practice-owned.',provenance='Combined positive-only search saved in original audit; exact index attribution unavailable.')]
            self.assertEqual(import_reviews(db,[review])['new_verified'],1)
            q=SqliteQueue(db);row=q.conn.execute('SELECT * FROM candidates').fetchone()
            import json
            proof=json.loads(row['result_json']);proof['operator_review']['supplemental_results'][0]['disposition']='uncertain'
            self.assertFalse(q._verified_for_export(row,proof,row['status']))
            q.close()
