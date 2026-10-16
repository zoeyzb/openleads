import csv,sqlite3,tempfile,unittest
from pathlib import Path
from ops.local_law.export_maps_no_listed_site import export
class MapLeadResearchExportTests(unittest.TestCase):
 def test_exports_only_unverified_candidates_and_excludes_owned_site_signals(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);db=root/'law.db';out=root/'research.csv'
   c=sqlite3.connect(db)
   c.executescript('''CREATE TABLE maps_raw_candidates(map_id TEXT PRIMARY KEY,firm TEXT,phone TEXT,city TEXT,state TEXT,maps_url TEXT,status TEXT);
    CREATE TABLE maps_website_checks(map_id TEXT PRIMARY KEY,checked_at TEXT,status TEXT,result_json TEXT);''')
   c.executemany('INSERT INTO maps_raw_candidates VALUES(?,?,?,?,?,?,?)',[
    ('a','Sample Law LLP','3124221836','Chicago','IL','https://www.google.com/maps/place/Sample','unverified_headcount'),
    ('b','Known Website Lawyers','3124221837','Chicago','IL','https://www.google.com/maps/place/HasSite','unverified_headcount')])
   c.execute("INSERT INTO maps_website_checks VALUES('b','2026-10-16T00:00:00Z','review_website','{}')")
   c.commit();c.close()
   result=export(db,out)
   self.assertEqual(result['research_prospects'],1)
   with out.open() as f: rows=list(csv.DictReader(f))
   self.assertEqual(rows[0]['Calling qualified'],'NO')
   self.assertEqual(rows[0]['Independent website status'],'not_checked')
if __name__=='__main__':unittest.main()
