import csv, importlib.util, json, sqlite3, tempfile, unittest
from pathlib import Path
from datetime import datetime,timezone,timedelta
SPEC=importlib.util.spec_from_file_location("campaign",str(Path(__file__).parent/"campaign.py"))
campaign=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(campaign)
class ExportTests(unittest.TestCase):
 def setUp(self):
  self.t=tempfile.TemporaryDirectory(); self.root=Path(self.t.name)
  self.orig=(campaign.DB,campaign.OUT)
  campaign.DB=self.root/"leads.sqlite3";campaign.OUT=self.root/"strict.csv"
  c=sqlite3.connect(campaign.DB)
  c.execute("CREATE TABLE candidates(firm TEXT,phone TEXT,city TEXT,state TEXT,source_url TEXT,status TEXT,result_json TEXT)")
  self.c=c
 def tearDown(self):
  self.c.close();campaign.DB,campaign.OUT=self.orig;self.t.cleanup()
 def add(self,status="strict_eligible",email="info@sample-law.test",site_status="screened_no_site",attorneys=5,checked=None,email_source="https://www.lawyers.com/firm/fixture",headcount_source="https://www.lawyers.com/firm/fixture"):
  v={"status":status,"email":email,"site_status":site_status,"attorneys":attorneys,
     "phone":"3125552222","site_evidence":{"providers":[{"responded":True,"urls":[]},{"responded":True,"urls":[]}]},
     "checked_at":checked or datetime.now(timezone.utc).isoformat(),"email_source":email_source,"headcount_source":headcount_source}
  self.c.execute("INSERT INTO candidates VALUES(?,?,?,?,?,?,?)",("Fixture & Partners","3125552222","Chicago","IL","https://www.lawyers.com/firm/fixture",status,json.dumps(v)));self.c.commit()
 def test_strict_record_exported(self):
  self.add()
  self.assertEqual(campaign.strict_export(),1)
  with campaign.OUT.open() as fd:
   self.assertEqual(len(list(csv.DictReader(fd))),1)
 def test_phone_only_excluded(self):
  self.add(status="call_qualified_no_email")
  self.assertEqual(campaign.strict_export(),0)
 def test_missing_published_email_proof_excluded(self):
  self.add(email_source="")
  self.assertEqual(campaign.strict_export(),0)
 def test_possible_owned_site_excluded(self):
  self.add(site_status="review_website")
  self.assertEqual(campaign.strict_export(),0)
 def test_stale_evidence_excluded(self):
  self.add(checked=(datetime.now(timezone.utc)-timedelta(days=40)).isoformat())
  self.assertEqual(campaign.strict_export(),0)
if __name__=="__main__":unittest.main()
