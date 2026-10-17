import json,sqlite3,tempfile,unittest
from pathlib import Path
from ops.local_law.plea_source import parse_directory,group_contacts,ingest,audit_sites

PAGE='''<html><section class="hp-what">
<div class="row attorney" id="post_101"><div><h2>Janice Doe</h2><h3><span class="small-text">of</span> Dover & Associates LLP</h3><p>120 Some Street<br>Dover, DE 19901</p></div><div><p>Phone: <a href="tel:302-678-9900">302-678-9900</a></p><p>Email: <a href="mailto:janice@examplefirm.com">janice@examplefirm.com</a></p></div></div>
<div class="row attorney" id="post_102"><div><h2>Sam Jones</h2><h3><span class="small-text">of</span> Dover & Associates LLP</h3></div><div><p>Phone: <a href="tel:302-678-9900">302-678-9900</a></p><p>Email: <a href="mailto:sam@examplefirm.com">sam@examplefirm.com</a></p></div></div>
<div class="row attorney" id="post_103"><div><h2>Solo Lawyer</h2><h3><span class="small-text">of</span> Solo Law Office</h3></div><div><p>Phone: <a href="tel:302-332-1886">302-332-1886</a></p><p>Email: <a href="mailto:solo@somemail.com">solo@somemail.com</a></p></div></div>
</section><footer>Phone: <a href="tel:312-999-2883">312-999-2883</a> Email: <a href="mailto:info@plea.net">info@plea.net</a></footer></html>'''
class PleaSourceTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.path=Path(self.tmp.name)/'research.sqlite3'
 def tearDown(self):self.tmp.cleanup()
 def test_cards_scoped_not_association_footer(self):
  records=parse_directory(PAGE,'de')
  self.assertEqual(len(records),3)
  self.assertEqual(records[0]['firm'],'Dover & Associates LLP')
  self.assertEqual(records[0]['source_url'],'https://plea.net/attorneys/de/#post_101')
  self.assertEqual(records[0]['phone'],'3026789900')
  self.assertEqual(records[0]['city'],'Dover')
  self.assertNotIn('info@plea.net',[p['email'] for p in records])
 def test_members_dedup_and_practitioner_count_not_firmwide(self):
  source=parse_directory(PAGE,'de')
  rows=group_contacts(source+[source[1]])
  self.assertEqual(len(rows),2)
  self.assertEqual(rows[0]['member_count'],2)
  self.assertEqual(len(rows[0]['members']),2)
  self.assertEqual(rows[1]['member_count'],1)
 def test_different_alias_same_phone_is_flagged_for_review(self):
  rows=parse_directory(PAGE,'de')
  rows[1]['firm']='Unrelated Employer'
  groups=group_contacts(rows)
  self.assertEqual(len(groups),3)
  self.assertTrue(groups[0]['shared_phone_conflict'])
 def test_ingest_persists_research_only_and_rechecks_idempotently(self):
  calls=[]
  def fetch(url,timeout=12):calls.append(url);return PAGE
  first=ingest(self.path,states=['de'],fetch=fetch)
  self.assertEqual(first['member_contacts_found'],3)
  self.assertEqual(first['new_firm_research'],2)
  self.assertEqual(first['two_or_more_listed_members'],1)
  self.assertTrue(first['new_firm_research']>0)
  second=ingest(self.path,states=['de'],fetch=lambda *args,**kwargs:(_ for _ in ()).throw(AssertionError('duplicate fetch')))
  self.assertEqual(second['fetched_pages'],0)
  self.assertEqual(second['total_firms'],2)
  c=sqlite3.connect(self.path)
  self.assertEqual(c.execute('SELECT COUNT(*) FROM plea_firm_research').fetchone()[0],2)
  self.assertEqual(c.execute("SELECT COUNT(*) FROM sqlite_master WHERE name='candidates'").fetchone()[0],0)
  c.close()
 def test_unavailable_directory_does_not_get_retried_every_hour(self):
  calls=[]
  def fail(url,timeout=12):
   calls.append(url)
   raise OSError('public source down')
  first=ingest(self.path,states=['de'],fetch=fail)
  self.assertEqual(first['source_errors'],1)
  second=ingest(self.path,states=['de'],fetch=fail)
  self.assertEqual(second['source_errors'],0)
  self.assertEqual(len(calls),1)

 def test_degraded_provider_stops_before_search(self):
  ingest(self.path,states=['de'],fetch=lambda *args,**kwargs:PAGE)
  result=audit_sites(self.path,search=lambda *_:(_ for _ in ()).throw(AssertionError('outage must block')),
         health=lambda:{'status':'degraded','positive_control_found':False})
  self.assertEqual(result['attempted'],0)
  self.assertEqual(result['reason'],'positive_owned_site_control_failed')
 def test_site_holds_are_not_qualified_and_solo_skipped(self):
  ingest(self.path,states=['de'],fetch=lambda *args,**kwargs:PAGE)
  searches=[]
  def search(lead):
   searches.append(lead['firm'])
   return [{'provider':'searxng:yandex','responded':True,'urls':['https://dover-associates.example/']},
           {'provider':'searxng:yep','responded':True,'urls':['https://lawyers.com/example']}]
  ok={'status':'usable','positive_control_found':True}
  result=audit_sites(self.path,limit=8,search=search,health=lambda:ok)
  self.assertEqual(result['attempted'],1)
  self.assertEqual(result['possible_owned_sites'],1)
  self.assertEqual(result['strict_qualified_created'],0)
  self.assertEqual(searches,['Dover & Associates LLP'])
  again=audit_sites(self.path,limit=8,search=lambda *_:(_ for _ in ()).throw(AssertionError('hold repeated')),
                    health=lambda:ok)
  self.assertEqual(again['attempted'],0)
 def test_two_searches_with_only_directories_stage_no_site_not_eligible(self):
  ingest(self.path,states=['de'],fetch=lambda *args,**kwargs:PAGE)
  def search(_):return [{'provider':'searxng:yandex','responded':True,'urls':['https://www.lawyers.com/example']},
                         {'provider':'searxng:yep','responded':True,'urls':['https://justia.com/attorneys/example']}]
  res=audit_sites(self.path,search=search,health=lambda:{'status':'usable','positive_control_found':True})
  self.assertEqual(res['no_attributable_site_found'],1)
  c=sqlite3.connect(self.path)
  self.assertEqual(c.execute("SELECT website_status FROM plea_firm_research WHERE member_count=2").fetchone()[0],'screened_no_site')
  self.assertEqual(c.execute("SELECT COUNT(*) FROM sqlite_master WHERE name='candidates'").fetchone()[0],0)
  c.close()
 def test_all_states_and_dc_are_supported_without_unbounded_input(self):
  from ops.local_law.plea_source import STATES
  self.assertEqual(len(STATES),51)
  self.assertIn('de',STATES)
  self.assertIn('dc',STATES)
  self.assertIn('wi',STATES)

 def test_website_research_prioritizes_two_member_firm_with_public_mailbox(self):
  from ops.local_law.plea_source import ensure
  c=sqlite3.connect(self.path);ensure(c)
  rows=[('custom','Custom LLP',2,{'firm':'Custom LLP','phone':'3124221836','states':['IL'], 'members':[{'email':'a@customlawfirm.com','person':'Alice','source_url':'https://plea.net/attorneys/il/#post_11'}]}),
        ('free','Small & Good LLP',2,{'firm':'Small & Good LLP','phone':'7184221836','states':['NY'],'members':[{'email':'a@gmail.com','person':'Ali','source_url':'https://plea.net/attorneys/ny/#post_12'}]})]
  for id,firm,size,proof in rows:
   c.execute('INSERT INTO plea_firm_research\n     (id,firm,phone,member_count,research_json,collected_at)\n     VALUES(?,?,?,?,?,?)',
     (id,firm,proof['phone'],size,json.dumps(proof),'2026-10-17T00:00:00+00:00'))
  c.commit();c.close()
  called=[]
  def search(lead):
   called.append(lead['firm'])
   return [{'provider':'searxng:yandex','responded':True,'urls':['https://lawyers.com/example']},
           {'provider':'searxng:yep','responded':True,'urls':['https://justia.com/attorneys/example']}]
  result=audit_sites(self.path,limit=1,search=search,
           health=lambda:{'status':'usable','positive_control_found':True})
  self.assertEqual(result['attempted'],1)
  self.assertEqual(called,['Small & Good LLP'])

 def test_reject_unlisted_state_and_unreliable_html(self):
  with self.assertRaises(ValueError):parse_directory(PAGE,'xx')
  self.assertEqual(parse_directory('<html>info@plea.net</html>','de'),[])

if __name__=='__main__':unittest.main()
