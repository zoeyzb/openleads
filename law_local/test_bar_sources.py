"""Firm-size-first bar-source regression checks, including full strict eligibility."""
import tempfile
import unittest
from pathlib import Path
from law_local.bar_sources import extract_inbar_firm, bar_seed_harvest
from law_local.worker import evaluate_published_source, evaluate_candidate, SqliteQueue

URL="https://www.inbar.org/members/?id=29034873"
PROFILE="""<html><body>
<h1>Ms. Valerie Cowan</h1><div>valerie@examplemail.com</div>
<h2>Professional Information</h2>
<div>Cowan &amp; King, LLP</div><div>PO Box 90379</div>
<div>Indianapolis Indiana 46290 United States</div>
<div>(317) 246-8784 (Phone)</div>
<div>County (Professional): Marion</div>
<div>Indiana Bar License Status: Active in Good Standing</div>
<h2>Personal Information</h2>
<h2>Additional Information</h2>
<div>Firm/Organization Size: 2-10 attorneys</div>
</body></html>"""

class BarSourceTests(unittest.TestCase):
    def test_real_shape_professional_phone_and_firm_size(self):
        lead,why=extract_inbar_firm(URL,PROFILE)
        self.assertEqual(why,"candidate")
        self.assertEqual(lead["firm"],"Cowan & King, LLP")
        self.assertEqual(lead["phone"],"3172468784")
        src=evaluate_published_source(PROFILE,lead)
        self.assertEqual(src["attorney_range"],(2,10))
        self.assertEqual(src["attorneys"],2)
        self.assertEqual(src["emails"],["valerie@examplemail.com"])
        site=[{"responded":True,"urls":[]},{"responded":True,"urls":[]}]
        record=evaluate_candidate(lead,PROFILE,site,lambda _:True)
        self.assertEqual(record["status"],"strict_eligible")

    def test_no_website_not_proven_by_bar_source_alone(self):
        lead,why=extract_inbar_firm(URL,PROFILE)
        record=evaluate_candidate(lead,PROFILE,[],lambda _:True)
        self.assertEqual(record["status"],"inconclusive")

    def test_government_member_not_business_lead(self):
        test=PROFILE.replace("Cowan &amp; King, LLP","St. Joseph Circuit Court")
        lead,reason=extract_inbar_firm(URL,test)
        self.assertIsNone(lead)
        self.assertEqual(reason,"no_private_law_firm")

    def test_wrong_size_or_missing_business_phone_never_candidate(self):
        for value in ["1-10","1-5","11-50"]:
            lead,reason=extract_inbar_firm(URL,PROFILE.replace("2-10",value))
            self.assertIsNone(lead)
            self.assertEqual(reason,"missing_or_out_of_range_firm_size")
        lead,reason=extract_inbar_firm(URL,PROFILE.replace("(317) 246-8784 (Phone)",""))
        self.assertIsNone(lead)
        self.assertEqual(reason,"no_published_professional_phone")

    def test_checkpoint_and_unqualified_candidate_only(self):
        with tempfile.TemporaryDirectory() as folder:
            db=SqliteQueue(Path(folder)/"research.sqlite")
            def fetch(url,timeout=9):
                self.assertEqual(url,URL)
                return PROFILE
            out=bar_seed_harvest(db,urls=[URL,URL],fetch_fn=fetch,max_pages=2)
            self.assertEqual(out["candidates_added"],1)
            self.assertEqual(out["size_phone_candidates"],1)
            self.assertEqual(db.counts().get("calling_qualified"),0)
            out=bar_seed_harvest(db,urls=[URL],fetch_fn=fetch,max_pages=2)
            self.assertEqual(out["attempted"],0)
            db.close()

if __name__=="__main__":
    unittest.main()
