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
    def test_existing_candidate_is_promoted(self):
        with tempfile.TemporaryDirectory() as d:
            db=Path(d)/"q.db";r=fixture();q=SqliteQueue(db)
            q.add(r["lead"]);q.close()
            self.assertEqual(import_reviews(db,[r])["new_verified"],1)
if __name__=="__main__":unittest.main()
