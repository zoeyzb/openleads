import sqlite3
import tempfile
import unittest
from pathlib import Path
from ops.local_law.promote_source_verified import qualify,exact_contact_block,canonical,named_practitioners_proof
from law_local.worker import SqliteQueue

DIRECTORY = '''<html><div class="row attorney"><div><h3>of Other Law Group</h3></div>
<div>Phone: 302-999-2222 Email: other@firm.example</div></div>
<div class="row attorney"><div><h3>of Liguori & Morris</h3>
<p>46 The Green, Dover DE</p></div><div>Phone: 302-678-9900
Email: <a href="mailto:gmorris@lmylaw.com">gmorris@lmylaw.com</a></div></div></html>'''
ARTICLE = '''<h1>Council appoints new solicitor</h1><p>Gregory Morris of Liguori & Morris will serve.</p>
<p>The firm, Liguori & Morris, would offer assistance of James Liguori and Melissa Dill.</p><p>Firm Size: 3</p>'''
REVIEW = {
 'lead':{'firm':'Liguori & Morris','phone':'3026789900','city':'Dover','state':'DE'},
 'map_id':'liguori morris attorneys at law|3026789900',
 'private_practice_confirmed':True,'firmwide_2_10_review_confirmed':True,
 'named_attorneys':['Gregory Morris','James Liguori','Melissa Dill'],
 'reviewer':'source-backed-reviewer', 'email':'gmorris@lmylaw.com',
 'sources':{'identity':'https://plea.net/attorneys/de/',
            'email':'https://plea.net/attorneys/de/',
            'headcount':'https://milford-times.com/council-appoints-new-solicitor/'}}

class StrictConversionTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory()
  self.db=Path(self.temp.name)/'leads.sqlite3'
  q=SqliteQueue(self.db)
  q.conn.execute('CREATE TABLE maps_raw_candidates (map_id TEXT PRIMARY KEY,firm TEXT,phone TEXT,state TEXT)')
  q.conn.execute('INSERT INTO maps_raw_candidates VALUES(?,?,?,?)',(
   REVIEW['map_id'],'Liguori & Morris Attorneys at Law','3026789900','DE'))
  q.conn.commit();q.close()
 def tearDown(self):self.temp.cleanup()
 @staticmethod
 def source(url,timeout=12):
  return DIRECTORY if 'plea.net' in url else ARTICLE
 @staticmethod
 def search(lead):
  return [{'provider':'searxng:yandex','responded':True,'urls':['https://www.lawyers.com/example']},
          {'provider':'searxng:yep','responded':True,'urls':['https://www.lawyer.com/firm/example']}]
 @staticmethod
 def health(): return {'status':'usable','positive_control_found':True}
 def call(self,review=None,**kwargs):
  return qualify(self.db,review or REVIEW,fetch=self.source,search=kwargs.pop('search',self.search),
                 health=kwargs.pop('health',self.health),mx=kwargs.pop('mx',lambda _:True))
 def test_single_member_association_profile_scopes_published_contact(self):
  profile='<div class="memberDirectoryDetailsContainer"><div class="memberDirectoryDetailsHeaderContainer"><h2>Rebecca Rodriguez</h2><h3>Sauk Valley Law Group, LLC</h3></div><h4>Member profile details</h4><div class="fieldLabel"><span>Email</span></div><div class="fieldBody"><span><a href="mailto:rodriguez@saukvalleylaw.com">rodriguez@saukvalleylaw.com</a></span></div><div class="fieldLabel"><span>Phone</span></div><div class="fieldBody"><span>815-535-6769</span></div></div></div><div class="gadgetContentEditableArea">Association footer <a href="mailto:info@irela.org">info@irela.org</a></div>'
  self.assertTrue(exact_contact_block(profile,'Sauk Valley Law Group, LLC','8155356769',
                        'rodriguez@saukvalleylaw.com',source_url='https://www.irela.org/Sys/PublicProfile/63300247'))
  self.assertFalse(exact_contact_block(profile,'Sauk Valley Law Group, LLC','8155356769',
                        'info@irela.org',source_url='https://www.irela.org/Sys/PublicProfile/63300247'))
  self.assertFalse(exact_contact_block(profile,'Different Firm','8155356769',
                        'rodriguez@saukvalleylaw.com',source_url='https://www.irela.org/Sys/PublicProfile/63300247'))
  self.assertFalse(exact_contact_block(profile,'Sauk Valley Law Group, LLC','8155356769',
                        'rodriguez@saukvalleylaw.com',source_url='https://www.irela.org/Directory'))

 def test_real_scoped_directory_block_does_not_select_other_email(self):
  self.assertTrue(exact_contact_block(DIRECTORY,'Liguori & Morris','3026789900','gmorris@lmylaw.com'))
  self.assertFalse(exact_contact_block(DIRECTORY,'Liguori & Morris','3026789900','other@firm.example'))
 def test_live_source_verified_promotion_updates_strict_calling_counts(self):
  result=self.call()
  self.assertEqual(result['new_qualified'],1,result)
  q=SqliteQueue(self.db)
  self.assertEqual(q.counts()['calling_qualified'],1)
  self.assertEqual(q.counts()['strict_eligible'],1)
  self.assertEqual(self.call()['new_qualified'],0)
  q.close()
 def test_named_members_without_total_do_not_prove_upper_bound(self):
  partial=ARTICLE.replace('<p>Firm Size: 3</p>','')
  self.assertFalse(named_practitioners_proof(partial,REVIEW['lead']['firm'],REVIEW['named_attorneys']))
 def test_missing_published_email_cannot_promote(self):
  review={**REVIEW,'email':'other@firm.example'}
  result=self.call(review)
  self.assertEqual(result['new_qualified'],0)
  self.assertEqual(result['reason'],'no_scoped_published_phone_and_email')
 def test_headcount_source_missing_named_lawyer_cannot_promote(self):
  review={**REVIEW,'named_attorneys':['Gregory Morris','Sam Impossible']}
  result=self.call(review)
  self.assertEqual(result['reason'],'headcount_source_not_matched')
 def test_absent_firmwide_review_cannot_promote(self):
  review={**REVIEW,'firmwide_2_10_review_confirmed':False}
  result=self.call(review)
  self.assertEqual(result['reason'],'incomplete_review_requirements')
 def test_site_positive_control_failure_cannot_promote(self):
  result=self.call(health=lambda:{'status':'degraded','positive_control_found':False})
  self.assertEqual(result['reason'],'website_positive_control_failed')
 def test_owned_website_excludes_even_with_valid_contact_proof(self):
  def site(lead):
   out=self.search(lead)
   out[0]['urls']=['https://liguorimorrislaw.com/']
   return out
  result=self.call(search=site)
  self.assertEqual(result['reason'],'owned_site_or_unknown')
 def test_unresolved_owned_site_hold_cannot_claim_new_qualification(self):
  q=SqliteQueue(self.db)
  lead={**REVIEW['lead'], 'source_url':REVIEW['sources']['identity']}
  q.add(lead)
  q.record(lead,{'status':'review_website','site_status':'review_website',
                 'website_candidates':['https://possible-owned.example/']})
  q.close()
  result=self.call()
  self.assertEqual(result['new_qualified'],0,result)
  q=SqliteQueue(self.db)
  self.assertEqual(q.conn.execute('SELECT status FROM candidates').fetchone()[0],'review_website')
  q.close()
 def test_client_owned_contact_source_cannot_claim_no_website(self):
  review={**REVIEW, 'sources':{**REVIEW['sources'],
          'identity':'https://liguorimorris.example/contact',
          'email':'https://liguorimorris.example/contact'}}
  result=self.call(review)
  self.assertEqual(result['new_qualified'],0,result)
  self.assertEqual(result['reason'],'identity_source_may_be_owned_site')
 def test_no_website_site_check_is_not_enough_without_email_mx(self):
  result=self.call(mx=lambda _:False)
  self.assertEqual(result['new_qualified'],0,result)
  self.assertEqual(result['reason'],'email_mx_not_verified')

 def test_export_gate_demands_new_proof_fields(self):
  self.assertEqual(self.call()['new_qualified'],1)
  q=SqliteQueue(self.db)
  r=q.conn.execute("SELECT * FROM candidates WHERE status='strict_eligible'").fetchone()
  import json
  ev=json.loads(r['result_json']);ev['email_mx_ok']=False
  self.assertFalse(q._verified_for_export(r,ev,'strict_eligible'))
  ev=json.loads(r['result_json']);ev['attorneys']=1
  self.assertFalse(q._verified_for_export(r,ev,'strict_eligible'))
  q.close()

if __name__=='__main__':unittest.main()
