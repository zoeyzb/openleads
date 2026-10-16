import csv, importlib.util, json, sqlite3, tempfile, unittest
from unittest.mock import patch
from subprocess import CompletedProcess
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
  v={"status":status,"email":email,"site_status":site_status,"qualification_scope":"law_no_owned_website_any_size","attorneys":attorneys,
     "phone":"3125552222","site_evidence":{"providers":[{"responded":True,"urls":[]},{"responded":True,"urls":[]}]},
     "checked_at":checked or datetime.now(timezone.utc).isoformat(),"email_source":email_source,"headcount_source":headcount_source}
  self.c.execute("INSERT INTO candidates VALUES(?,?,?,?,?,?,?)",("Fixture & Partners","3125552222","Chicago","IL","https://www.lawyers.com/firm/fixture",status,json.dumps(v)));self.c.commit()
 def test_strict_record_exported(self):
  self.add()
  self.assertEqual(campaign.strict_export(),1)
  with campaign.OUT.open() as fd:
   self.assertEqual(len(list(csv.DictReader(fd))),1)
 def test_email_verified_without_attorney_count(self):
  self.add(attorneys=None)
  self.assertEqual(campaign.strict_export(),1)
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
class NewSourceSchedulerTests(unittest.TestCase):
 def test_free_index_is_included_without_disabling_other_sources(self):
  source=Path(__file__).parent.joinpath('campaign.py').read_text()
  self.assertIn('ops.local_law.commoncrawl_profiles',source)
  self.assertIn('archive_triage.py',source)
  self.assertIn('process_backlog()',source)

class SchedulerTests(unittest.TestCase):
 def test_no_geography_due_still_services_verification_backlog(self):
  with tempfile.TemporaryDirectory() as root:
   root=Path(root)
   # A job with all regions cooling down must still process recovered leads.
   with (patch.object(campaign,"ROOT",root),
         patch.object(campaign,"SRC",root/"openleads"),
         patch.object(campaign,"STATES",[]),
         patch.object(campaign,"command",return_value=CompletedProcess([],0,"{}","")),
         patch.object(campaign,"process_backlog",return_value=0) as verify,
         patch.object(campaign,"calling_export",return_value=0) as calling,
         patch.object(campaign,"strict_export",return_value=0) as strict):
    self.assertEqual(campaign.cycle(),0)
    verify.assert_called_once_with()
    calling.assert_called_once_with()
    strict.assert_called_once_with()

 def test_verifier_runs_as_importable_python_module(self):
  with tempfile.TemporaryDirectory() as root:
   with (patch.object(campaign,"ROOT",Path(root)),
         patch.object(campaign,"command",return_value=CompletedProcess([],0,'{"counts":{}}','')) as run):
    self.assertEqual(campaign.process_backlog(),0)
    args=run.call_args.args[0]
    self.assertEqual(args[:2],["-m","law_local.worker"])
    self.assertNotIn("law_local/worker.py",args)

if __name__=="__main__":unittest.main()
