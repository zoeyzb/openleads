import json,sqlite3,tempfile,unittest
from pathlib import Path
from ops.local_law.plea_source import ingest,confirm_explicit_owned_site
SOURCE='https://www.lawinfo.com/lawfirm/indiana/indianapolis/borinstein-springer-llp/a1.html'
PAGE='''<html><head><title>Dover & Associates LLP - Indianapolis lawyers</title></head>
<body><h1>Dover & Associates LLP</h1><p>Call us 302-678-9900</p>
<a href="https://www.doverassociates.example/">Visit Website</a>
<a href="mailto:admin@lawinfo.com">Contact</a></body></html>'''
DIRECTORY='''<html><section class="hp-what">
<div class="row attorney" id="post_123"><h2>Jane Doe</h2><h3>of Dover & Associates LLP</h3><p>Phone: <a href="tel:302-678-9900">302-678-9900</a></p><p>Email: <a href="mailto:jane@firm.example">jane@firm.example</a></p></div>
<div class="row attorney" id="post_124"><h2>Lisa Jones</h2><h3>of Dover & Associates LLP</h3><p>Phone: <a href="tel:302-678-9900">302-678-9900</a></p><p>Email: <a href="mailto:lisa@firm.example">lisa@firm.example</a></p></div>
</section></html>'''
class ExplicitSiteTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'research.sqlite3'
  ingest(self.path,states=['de'],fetch=lambda *a,**k:DIRECTORY)
  conn=sqlite3.connect(self.path)
  self.lead_id=conn.execute('select id from plea_firm_research').fetchone()[0]
  conn.close()
 def tearDown(self):self.tmp.cleanup()
 def check(self,source=SOURCE,body=PAGE):
  return confirm_explicit_owned_site(self.path,self.lead_id,source,fetch=lambda *a,**k:body)
 def test_explicit_matched_site_stored_once_with_immutable_prior_evidence(self):
  first=self.check()
  self.assertEqual(first['new_evidence'],1)
  self.assertEqual(first['status'],'published_owned_website')
  second=self.check();self.assertEqual(second['new_evidence'],0)
  db=sqlite3.connect(self.path)
  self.assertEqual(db.execute('select website_status from plea_firm_research').fetchone()[0],'published_owned_website')
  self.assertEqual(db.execute('select count(*) from plea_owned_site_audit_history').fetchone()[0],1)
  self.assertEqual(db.execute("select count(*) from external_evidence where kind='owned_website'").fetchone()[0],1)
  self.assertEqual(db.execute("select count(*) from sqlite_master where name='candidates'").fetchone()[0],0)
  db.close()
 def test_wrong_firm_or_phone_cannot_exclude(self):
  self.assertEqual(self.check(body=PAGE.replace('302-678-9900','212-678-9900'))['reason'],'source_firm_phone_mismatch')
  self.assertEqual(self.check(body=PAGE.replace('Dover & Associates LLP','Different Law PLC'))['reason'],'source_firm_phone_mismatch')
 def test_page_without_website_label_cannot_exclude(self):
  self.assertEqual(self.check(body=PAGE.replace('Visit Website','Directory contact'))['reason'],'no_single_attributable_website')
 def test_untrusted_urls_refused_before_network_fetch(self):
  result=confirm_explicit_owned_site(self.path,self.lead_id,'https://unknown.example/firm',
                      fetch=lambda *a,**k:(_ for _ in ()).throw(AssertionError('never fetch')))
  self.assertEqual(result['reason'],'untrusted_directory_source')
 def test_multiple_explicit_websites_need_operator_review(self):
  result=self.check(body=PAGE.replace('</body>', '<a href="https://second-firm.example">Visit Website</a></body>'))
  self.assertEqual(result['reason'],'no_single_attributable_website')
  self.assertEqual(result['candidates'],2)
 def test_source_unavailable_is_not_absence(self):
  result=confirm_explicit_owned_site(self.path,self.lead_id,SOURCE,fetch=lambda *a,**k:(_ for _ in ()).throw(OSError('temporarily unavailable')))
  self.assertEqual(result['reason'],'source_unavailable')

if __name__=='__main__':unittest.main()
