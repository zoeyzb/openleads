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
 def test_verified_and_inactive_records_are_not_research_exports(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);db=root/'law.db'
   c=sqlite3.connect(db)
   c.executescript('CREATE TABLE maps_raw_candidates(map_id TEXT PRIMARY KEY,firm TEXT,phone TEXT,city TEXT,state TEXT,maps_url TEXT,status TEXT); CREATE TABLE maps_website_checks(map_id TEXT PRIMARY KEY,checked_at TEXT,status TEXT,result_json TEXT);')
   for i,status in enumerate(('screened_no_site','rejected_inactive','manual_followup_required')):
    c.execute('INSERT INTO maps_raw_candidates VALUES(?,?,?,?,?,?,?)',(str(i),'Sample Law LLP','3124221836','Chicago','IL','https://google.com/maps','unverified_headcount'))
    c.execute('INSERT INTO maps_website_checks VALUES(?,?,?,?)',(str(i),'2026-10-16T00:00:00Z',status,'{}'))
   c.commit();c.close()
   self.assertEqual(export(db,root/'out.csv')['research_prospects'],1)
 def test_external_owned_site_evidence_excludes_only_matched_maps_record(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);db=root/'law.db';catalog=root/'research_catalog.sqlite3'
   with sqlite3.connect(db) as c:
    c.executescript('''CREATE TABLE maps_raw_candidates(map_id TEXT PRIMARY KEY,firm TEXT,phone TEXT,city TEXT,state TEXT,maps_url TEXT,status TEXT);''')
    c.executemany('INSERT INTO maps_raw_candidates VALUES(?,?,?,?,?,?,?)',[
     ('vanwinkle law office|3197503758','VanWinkle Law Office','3197503758','Burlington','IA','https://maps.google.com/?cid=1','unverified_headcount'),
     ('another law office|3197503759','Another Law Office','3197503759','Burlington','IA','https://maps.google.com/?cid=2','unverified_headcount')])
   with sqlite3.connect(catalog) as c:
    c.execute('CREATE TABLE external_evidence(lead_id TEXT,kind TEXT,proof_url TEXT,note TEXT,verified_at TEXT)')
    c.execute('INSERT INTO external_evidence VALUES(?,?,?,?,?)',('maps:vanwinkle law office|3197503758','owned_website','https://heidivanwinklelaw.com','Firm-matched owned domain','2026-10-16T00:00:00Z'))
   result=export(db,root/'out.csv',catalog)
   self.assertEqual(result['research_prospects'],1)
   with (root/'out.csv').open() as f: rows=list(csv.DictReader(f))
   self.assertEqual(rows[0]['Firm'],'Another Law Office')

if __name__=='__main__':unittest.main()
