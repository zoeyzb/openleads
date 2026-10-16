import json, sqlite3, tempfile, unittest
from pathlib import Path
from ops.local_law.reconcile_owned_sites import direct_owned_proof, reconcile

class TestReconcile(unittest.TestCase):
 def test_proof_filter(self):
  self.assertFalse(direct_owned_proof("https://www.floridabar.org/directories", "Official bar profile"))
  self.assertFalse(direct_owned_proof("https://aa-lawgroup.com", "Phone differs, unresolved"))
  self.assertTrue(direct_owned_proof("https://awslaw.org/", "Firm-owned site matches phone"))
 def test_idempotence(self):
  with tempfile.TemporaryDirectory() as d:
   q=Path(d)/"q.sqlite";r=Path(d)/"r.sqlite"
   with sqlite3.connect(q) as c:
    c.execute("CREATE TABLE candidates(id TEXT,firm TEXT,phone TEXT,state TEXT,status TEXT,result_json TEXT,attempts INT,updated TEXT)")
    c.execute("INSERT INTO candidates VALUES(?,?,?,?,?,?,?,?)",("id1","AWS Law Firm","8139225293","FL","review_headcount_scope",'{"headcount_scope":"florida_active_attorneys_only"}',2,""))
   with sqlite3.connect(r) as c:
    c.execute("CREATE TABLE source_research(lead_id TEXT,firm TEXT,phone TEXT,state TEXT)")
    c.execute("CREATE TABLE external_evidence(lead_id TEXT,kind TEXT,proof_url TEXT,note TEXT,verified_at TEXT)")
    c.execute("INSERT INTO source_research VALUES(?,?,?,?)",("id1","AWS Law Firm","8139225293","FL"))
    c.execute("INSERT INTO external_evidence VALUES(?,?,?,?,?)",("id1","owned_website","https://awslaw.org/","Firm-owned site matches phone","2026-10-16T00:00:00Z"))
   self.assertEqual(reconcile(q,r)["owned_site_queue_reconciled"],1)
   self.assertEqual(reconcile(q,r)["owned_site_queue_reconciled"],0)
   with sqlite3.connect(q) as c: status,raw,attempts=c.execute("SELECT status,result_json,attempts FROM candidates").fetchone()
   self.assertEqual((status,attempts),("review_website",2))
   self.assertEqual(json.loads(raw)["headcount_scope"],"florida_active_attorneys_only")

if __name__=="__main__": unittest.main()
