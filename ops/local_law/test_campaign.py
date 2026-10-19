import csv, importlib.util, json, sqlite3, tempfile, unittest
from unittest.mock import patch
from subprocess import CompletedProcess
from pathlib import Path
from datetime import datetime,timezone,timedelta
SPEC=importlib.util.spec_from_file_location("campaign",str(Path(__file__).parent/"campaign.py"))
campaign=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(campaign)
class FreeSearchSchedulingTests(unittest.TestCase):
 def test_website_verification_uses_selfhosted_engines_by_default(self):
  from unittest.mock import patch
  with patch.object(campaign.subprocess,'run',return_value=CompletedProcess([],0,'','')) as r, patch.dict(campaign.os.environ,{},clear=True):
   campaign.command(['-m','law_local.worker','--db','/tmp/not-real.db','run'],4)
   self.assertEqual(r.call_args.kwargs['env']['OPENLEADS_SEARCH_MODE'],'local_forks')
   campaign.command(['-m','ops.local_law.screen_maps_websites','--max','2'],4)
   self.assertEqual(r.call_args.kwargs['env']['OPENLEADS_SEARCH_MODE'],'local_forks')
   campaign.command(['-m','law_local.worker','discover','--states','TX'],4)
   self.assertEqual(r.call_args.kwargs['env']['OPENLEADS_SEARCH_MODE'],'local_forks')
 def test_explicit_mode_is_honored_not_overwritten(self):
  with patch.object(campaign.subprocess,'run',return_value=CompletedProcess([],0,'','')) as r, patch.dict(campaign.os.environ,{'OPENLEADS_SEARCH_MODE':'legacy'},clear=True):
   campaign.command(['-m','law_local.worker','run'],3)
   self.assertEqual(r.call_args.kwargs['env']['OPENLEADS_SEARCH_MODE'],'legacy')

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
  v={"status":status,"email":email,"site_status":site_status,"qualification_scope":"law_no_owned_website_2_10_email","attorneys":attorneys,
     "phone":"3125552222","site_evidence":{"providers":[{"responded":True,"urls":[]},{"responded":True,"urls":[]}]},
     "checked_at":checked or datetime.now(timezone.utc).isoformat(),"email_source":email_source,"headcount_source":headcount_source}
  self.c.execute("INSERT INTO candidates VALUES(?,?,?,?,?,?,?)",("Fixture & Partners","3125552222","Chicago","IL","https://www.lawyers.com/firm/fixture",status,json.dumps(v)));self.c.commit()
 def test_strict_record_exported(self):
  self.add()
  self.assertEqual(campaign.strict_export(),1)
  with campaign.OUT.open() as fd:
   self.assertEqual(len(list(csv.DictReader(fd))),1)
 def test_email_without_verified_attorney_count_is_allowed(self):
  self.add(attorneys=None)
  self.assertEqual(campaign.strict_export(),1)
 def test_published_email_without_firm_size_source_is_allowed(self):
  self.add(attorneys=5,headcount_source="")
  self.assertEqual(campaign.strict_export(),1)
 def test_strict_email_export_deduplicates_shared_phone(self):
  self.add()
  self.add()
  self.assertEqual(campaign.strict_export(),1)
  with campaign.OUT.open() as handle:
   self.assertEqual(len(list(csv.DictReader(handle))),1)
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
class HarveySourceSchedulerTests(unittest.TestCase):
 def test_hourly_sync_is_strict_only_and_no_autosend_or_unhealthy_discovery(self):
  with tempfile.TemporaryDirectory() as work, patch.object(campaign,'ROOT',Path(work)), \
       patch.object(campaign,'command',return_value=CompletedProcess([],0,'{"strict_companies":3}','')) as runner, \
       patch.dict(campaign.os.environ,{},clear=True):
   campaign.harvey_cycle()
   self.assertEqual(runner.call_count,1)
   self.assertEqual(runner.call_args.args[0],['-m','ops.local_law.harvey_bridge','sync-strict'])
   self.assertNotIn('run',str(runner.call_args.args[0]))
   history=(Path(work)/'campaign-runs.log').read_text()
   self.assertIn('harvey_strict_sync_exit',history)
   self.assertNotIn('harvey_osm_exit',history)
 def test_osm_discovery_needs_explicit_opt_in_and_small_batch(self):
  with tempfile.TemporaryDirectory() as work, patch.object(campaign,'ROOT',Path(work)), \
       patch.object(campaign,'command',return_value=CompletedProcess([],0,'{}','')) as runner, \
       patch.dict(campaign.os.environ,{'HARVEY_OSM_AUTOMATIC':'1'}):
   campaign.harvey_cycle()
   self.assertEqual(runner.call_count,2)
   discovery=runner.call_args.args[0]
   self.assertEqual(discovery[:3],['-m','ops.local_law.harvey_bridge','discover-osm'])
   self.assertEqual(discovery[-2:],['--max','25'])

class NewSourceSchedulerTests(unittest.TestCase):
 def test_free_index_is_included_without_disabling_other_sources(self):
  source=Path(__file__).parent.joinpath('campaign.py').read_text()
  self.assertIn('ops.local_law.commoncrawl_profiles',source)
  self.assertIn('archive_triage.py',source)
  self.assertIn('process_backlog()',source)

class PLEASourceSchedulerTests(unittest.TestCase):
 def test_plea_source_is_attached_as_bounded_research_without_automatic_promotion(self):
  source=Path(__file__).parent.joinpath('campaign.py').read_text()
  self.assertIn('ops.local_law.plea_source","ingest',source)
  self.assertIn('ops.local_law.plea_source","audit-sites","--max","12',source)
  self.assertIn('plea_source_ingest_exit',source)
  self.assertIn('plea_site_audit_exit',source)
  # A source-only website audit is never an eligible caller import.
  self.assertNotIn('plea_source","promote',source)

class SchedulerTests(unittest.TestCase):
 def test_repaired_provider_releases_legacy_zero_yield_hold_once(self):
  with tempfile.TemporaryDirectory() as root,patch.object(campaign,"ROOT",Path(root)):
   db=campaign.connect()
   db.execute("DELETE FROM coverage_method_migrations")
   db.execute("INSERT INTO areas(state,source,next_retry,last_error) VALUES('TX','directory','2099-01-01','zero_source_yield')")
   db.commit();db.close()
   db=campaign.connect()
   self.assertIsNone(db.execute("SELECT next_retry FROM areas").fetchone()[0])
   db.execute("UPDATE areas SET next_retry='2099-01-01',last_error='zero_source_yield'")
   db.commit();db.close()
   db=campaign.connect()
   self.assertEqual(db.execute("SELECT next_retry FROM areas").fetchone()[0],'2099-01-01')
   db.close()

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

class IrelaCampaignTest(unittest.TestCase):
 def test_source_is_bounded_and_uses_canonical_db(self):
  source=Path(campaign.__file__).read_text()
  self.assertIn('law_local.irela_source","--db",str(DB)',source)
  self.assertIn('irela_contacts_exit',source)

class NYDiscoveryResultTests(unittest.TestCase):
 def test_official_contact_staging_is_counted_as_discovery_only(self):
  payload={'official_ny_acquisition':{'groups_fetched':500},'added_unverified':20,'qualified_created':0}
  self.assertEqual(campaign.discovery_result(0,json.dumps(payload)),'candidates_added')
  payload['added_unverified']=0
  self.assertEqual(campaign.discovery_result(0,json.dumps(payload)),'zero_source_yield')
  self.assertEqual(campaign.discovery_result(1,json.dumps(payload)),'failed')
