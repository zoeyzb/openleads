import csv,sqlite3,tempfile,unittest
from pathlib import Path
from ops.local_law.export_review_shortlist import export
class ShortlistTests(unittest.TestCase):
 def test_does_not_claim_unverified_sources_are_qualified(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'db.sqlite';c=sqlite3.connect(p)
   c.executescript('''CREATE TABLE source_research(lead_id TEXT,firm TEXT,phone TEXT,city TEXT,state TEXT,source_url TEXT,source TEXT,reported_attorneys INTEGER,proof_status TEXT);CREATE TABLE source_triage(lead_id TEXT,status TEXT,website_url TEXT);CREATE TABLE external_evidence(lead_id TEXT,kind TEXT);''')
   rows=[('1','Miller & Stone LLP','3124221836','Chicago','IL','https://example.org/miller','FL roster',3,'needs_firmwide_size_and_owned_site'),('2','State Attorney Office','3124221837','Chicago','IL','https://example.org/state','FL roster',3,'needs_firmwide_size_and_owned_site'),('3','Public Law PLLC','3124221838','Chicago','IL','https://example.org/public','FL roster',3,'needs_firmwide_size_and_owned_site')]
   c.executemany('INSERT INTO source_research VALUES (?,?,?,?,?,?,?,?,?)',rows)
   c.execute("INSERT INTO external_evidence VALUES('3','owned_website')");c.commit();c.close()
   dest=Path(d)/'queue.csv';result=export(p,dest,1000)
   self.assertEqual(result['research_queue_rows'],1)
   self.assertEqual(result['verified_qualified_leads_created'],0)
   with dest.open() as f:
    items=list(csv.DictReader(f));self.assertEqual(items[0]['Qualified for calling'],'NO')
 def test_balances_sources_for_nationwide_research_queue(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'db.sqlite';c=sqlite3.connect(p)
   c.executescript('''CREATE TABLE source_research(lead_id TEXT,firm TEXT,phone TEXT,city TEXT,state TEXT,source_url TEXT,source TEXT,reported_attorneys INTEGER,proof_status TEXT);CREATE TABLE source_triage(lead_id TEXT,status TEXT,website_url TEXT);CREATE TABLE external_evidence(lead_id TEXT,kind TEXT);''')
   for i in range(5):
    c.execute('INSERT INTO source_research VALUES(?,?,?,?,?,?,?,?,?)',(str(i),f'Firm Example {i} LLP',f'312422{1800+i}','', 'FL','https://example.org/fl','FL roster',3,'unknown'))
    c.execute('INSERT INTO source_research VALUES(?,?,?,?,?,?,?,?,?)',(str(i+10),f'Other Group {i} PLLC',f'917422{1800+i}','New York','NY','https://example.org/ny','NY registrations',3,'unknown'))
   c.commit();c.close()
   result=export(p,Path(d)/'shortlist.csv',6)
   self.assertEqual(result['by_source'],{'FL roster':3,'NY registrations':3})
if __name__=='__main__':unittest.main()
