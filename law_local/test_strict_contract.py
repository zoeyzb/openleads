"""Regressions for the current strict 2–10 contract; all contacts are fixtures."""
import tempfile,time,unittest
from pathlib import Path
from unittest.mock import patch
from law_local.worker import SqliteQueue,utc_now,_search_directory_profiles
from law_local import free_search
from law_local.site_provider_health import bounded_sources

class ContractTests(unittest.TestCase):
 def test_any_size_metadata_does_not_block_but_duplicate_providers_do(self):
  lead={"firm":"Fixture Law","phone":"3124221836","state":"IL","source_url":"https://www.lawyers.com/firm/fixture"}
  base={"phone":lead["phone"],"status":"strict_eligible","attorneys":4,
        "headcount_source":lead["source_url"],"email":"fixture@example.com",
        "email_source":lead["source_url"],"qualification_scope":"law_no_owned_website_2_10_email",
        "site_status":"screened_no_site","checked_at":utc_now(),
        "site_evidence":{"providers":[{"provider":"one","responded":True},{"provider":"two","responded":True}]}}
  self.assertTrue(SqliteQueue._verified_for_export(lead,base,"strict_eligible"))
  for change in ({"attorneys":1},{"attorneys":None},
      {"headcount_note":"Office Type and Size: Law firm with 2-5 WSBA members"},
      {"qualification_scope":"law_no_owned_website_any_size"},
      {"site_evidence":{"providers":[{"provider":"one","responded":True}]*2}}):
   with self.subTest(change=change):
    self.assertEqual(SqliteQueue._verified_for_export(lead,{**base,**change},"strict_eligible"), "site_evidence" not in change)
 def test_selfhosted_discovery_uses_real_urls_and_no_legacy_network(self):
  responses=[{"responded":True,"urls":["https://www.lawyer.com/firm/fixture.html","https://unrelated.example/"]}]*2
  with patch.dict("os.environ",{"OPENLEADS_SEARCH_MODE":"local_forks"}),patch.object(free_search,"searx_engine",side_effect=responses):
   self.assertEqual(_search_directory_profiles("fixture"),["https://www.lawyer.com/firm/fixture.html"])
 def test_published_email_domain_positive_survives_firm_label_mismatch(self):
  def engine(query,name,**kw):
   urls=["https://typo-free-firm.example/contact"] if query.startswith("site:") else ["https://www.lawyers.com/fixture"]
   return {"provider":"searxng:"+name,"responded":True,"urls":urls}
  with patch.object(free_search,"searx_engine",side_effect=engine):
   got=free_search.search_firm({"firm":"Typo Frm","emails":["lawyer@typo-free-firm.example"]})
  hint=next(v for v in got if v["provider"]=="published_email_domain_positive_only")
  self.assertEqual(hint["urls"],["https://typo-free-firm.example/contact"])
  self.assertFalse(hint["responded"])
 def test_shared_published_email_is_deduplicated_in_counts_and_csv(self):
  from law_local.worker import evaluate_candidate
  with tempfile.TemporaryDirectory() as root:
   q=SqliteQueue(Path(root)/"queue.db")
   for firm,phone in [("Fixture Alpha Law","3124221836"),("Fixture Beta Law","3124221837")]:
    lead={"firm":firm,"phone":phone,"state":"IL","source_url":"https://www.lawyers.com/firm/fixture"}
    page=f"<h1>{firm}</h1><p>Call {phone}</p><p>Firm Size: 4</p><p>business@fixturemail.testing-law.org</p>"
    result=evaluate_candidate(lead,page,[{"provider":"one","responded":True,"urls":[]},{"provider":"two","responded":True,"urls":[]}],lambda _:True)
    q.add(lead);q.record(lead,result)
   self.assertEqual(q.counts()["strict_eligible"],1)
   self.assertEqual(q.export("strict_eligible",Path(root)/"strict.csv"),1)
   q.close()
 def test_provider_wall_clock_deadline_reaps_child(self):
  started=time.monotonic()
  out=bounded_sources(seconds=0.001)
  self.assertLess(time.monotonic()-started,3)
  self.assertFalse(out[0]["responded"])
  self.assertEqual(out[0]["reason"],"wall_clock_timeout")
 def test_interrupted_export_preserves_previous_complete_csv(self):
  with tempfile.TemporaryDirectory() as root:
   q=SqliteQueue(Path(root)/"queue.db");target=Path(root)/"calls.csv"
   target.write_text("previous-complete-export")
   with patch.object(q,"_verified_rows",side_effect=RuntimeError("interrupted")):
    with self.assertRaises(RuntimeError):q.export("calling_qualified",target)
   self.assertEqual(target.read_text(),"previous-complete-export")
   q.close()

class MapRetryTests(unittest.TestCase):
 def test_source_outage_cools_down_instead_of_repeating_first_firm(self):
  from law_local.maps_first import verify_map_headcounts
  with tempfile.TemporaryDirectory() as root:
   q=SqliteQueue(Path(root)/"queue.db")
   q.conn.execute("CREATE TABLE maps_raw_candidates(map_id TEXT,firm TEXT,phone TEXT,city TEXT,state TEXT,status TEXT,added_at TEXT)")
   q.conn.execute("INSERT INTO maps_raw_candidates VALUES('fixture','Fixture Law','3124221836','Chicago','IL','unverified_headcount','')")
   q.conn.commit()
   resolver=unittest.mock.Mock(return_value={"responded":0,"urls":[]})
   first=verify_map_headcounts(q,source_resolver=resolver)
   second=verify_map_headcounts(q,source_resolver=resolver)
   self.assertEqual(first["maps_checked"],1)
   self.assertEqual(second["source_cooldown_skips"],1)
   self.assertEqual(resolver.call_count,1)
   self.assertEqual(q.counts()["strict_eligible"],0)
   q.close()
