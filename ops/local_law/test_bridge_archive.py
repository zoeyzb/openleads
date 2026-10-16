import importlib.util,sqlite3,tempfile,unittest
from pathlib import Path
from law_local.worker import SqliteQueue
spec=importlib.util.spec_from_file_location("bridge_archive",Path(__file__).parent/"bridge_archive.py")
bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)
class BridgeTests(unittest.TestCase):
 def test_bounded_import_and_dedupe(self):
  with tempfile.TemporaryDirectory() as d:
   catalog=Path(d)/"catalog.sqlite"; db=Path(d)/"queue.sqlite"
   c=sqlite3.connect(catalog)
   c.execute("CREATE TABLE source_research (lead_id TEXT,firm TEXT,phone TEXT,city TEXT,state TEXT,source_url TEXT,reported_attorneys INTEGER,proof_status TEXT,source TEXT)")
   c.execute("CREATE TABLE source_triage (lead_id TEXT,status TEXT)")
   for n in range(6):
    c.execute("INSERT INTO source_research VALUES (?,?,?,?,?,?,?,?,?)",(str(n),f"Example Law Firm {n}",f"312888{2000+n}","Chicago","IL",f"https://lawyer.com/firm/firm-{n}.html",4,"needs_firmwide_size_and_owned_site","FL roster"))
   c.execute("INSERT INTO source_research VALUES (?,?,?,?,?,?,?,?,?)",("bad","Big Office","3128889000","Chicago","IL","https://lawyer.com/firm/big.html",40,"needs_firmwide_size_and_owned_site","FL roster"))
   c.commit();c.close()
   q=SqliteQueue(db)
   try:
    self.assertEqual(bridge.bridge(catalog,q,3)["added_unverified"],3)
    self.assertEqual(bridge.bridge(catalog,q,3)["added_unverified"],3)
    self.assertEqual(q.counts().get("calling_qualified"),0)
    self.assertEqual(q.counts().get("pending"),6)
   finally:q.close()
if __name__=="__main__":unittest.main()
