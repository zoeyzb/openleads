import json,sqlite3,tempfile,unittest
from pathlib import Path
from law_local.worker import SqliteQueue,evaluate_candidate,email_domain_websites
from ops.local_law.any_size_policy import apply
from ops.local_law.test_plea_source import PAGE

class AnySizePolicyTests(unittest.TestCase):
 def test_migration_is_idempotent_preserves_adverse_evidence_and_never_qualifies(self):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);q=SqliteQueue(root/'law-leads.sqlite3')
   for index,extra in enumerate([{}, {'owned_site_url':'https://owned.testing-law.org/'}, {'eligibility_hold':{'reason':'inactive'}}]):
    lead={'firm':f'Fixture Law {index}','phone':f'312422183{index}','state':'IL','source_url':'https://www.lawyers.com/firm/fixture'}
    q.add(lead);q.record(lead,{'status':'review_firmwide_headcount','attorneys':None,**extra})
   q.close()
   self.assertEqual(apply(root)['requeued_for_fresh_checks'],1)
   self.assertEqual(apply(root)['requeued_for_fresh_checks'],0)
   q=SqliteQueue(root/'law-leads.sqlite3')
   self.assertEqual(q.counts()['strict_eligible'],0)
   self.assertEqual(q.counts()['pending'],1)
   self.assertEqual(q.conn.execute('SELECT COUNT(*) FROM qualification_policy_history').fetchone()[0],1)
   self.assertEqual(q.counts()['review_firmwide_headcount'],2)
   q.close()
 def test_directory_member_card_does_not_borrow_other_firm_phone_or_email(self):
  source='https://plea.net/attorneys/de/#post_101'
  providers=[{'provider':'one','responded':True,'urls':[]},{'provider':'two','responded':True,'urls':[]}]
  lead={'firm':'Dover & Associates LLP','phone':'3026789900','state':'DE','source_url':source}
  valid=evaluate_candidate(lead,PAGE,providers,lambda _:True)
  self.assertEqual(valid['status'],'strict_eligible')
  self.assertIn(valid['email'],['janice@examplefirm.com','sam@examplefirm.com'])
  self.assertEqual(evaluate_candidate({**lead,'phone':'3023321886'},PAGE,providers,lambda _:True)['status'],'unverified_identity')
 def test_email_domain_http_probe_is_positive_only(self):
  def fetch(url,timeout=3):return '<html>Actual website '+('content '*30)+'</html>'
  self.assertEqual(email_domain_websites(['person@fixturefirm.org'],fetch),['https://fixturefirm.org/'])
  self.assertEqual(email_domain_websites(['person@gmail.com'],lambda *a,**k:self.fail('queried public mailbox host')),[])
  def unavailable(*a,**k):raise TimeoutError('fixture outage')
  self.assertEqual(email_domain_websites(['person@fixturefirm.org'],unavailable),[])

 def test_any_size_policy_still_excludes_government_employers(self):
  from law_local.florida_roster import NON_PRIVATE
  for firm in ('IRS','Internal Revenue Service','DoAH','Fish & Wildlife Conservation Commission','Division of Administrative Hearings'):
   self.assertTrue(NON_PRIVATE.search(firm),firm)

class OperatorRecoveryTests(unittest.TestCase):
 def test_recovers_only_complete_fresh_active_review_without_alias_holds(self):
  from ops.local_law.test_import_site_reviews import fixture,import_reviews
  for unsafe in ('none','inactive_alias','expired','incomplete'):
   with self.subTest(unsafe=unsafe),tempfile.TemporaryDirectory() as folder:
    root=Path(folder);review=fixture()
    review['active_practice_evidence']={'url':review['lead']['source_url'],
        'checked_at':review['checked_at'],'note':'Current active private practice, fixture only'}
    import_reviews(root/'law-leads.sqlite3',[review])
    q=SqliteQueue(root/'law-leads.sqlite3')
    row=q.conn.execute('SELECT * FROM candidates').fetchone();e=json.loads(row['result_json'])
    e['status']='review_firmwide_headcount';e['qualification_hold']='prior_any_size_policy_not_current_qualification'
    if unsafe=='expired':e['operator_review']['checked_at']='2000-01-01T00:00:00+00:00'
    if unsafe=='incomplete':e['operator_review']['providers'][1]['results']=[]
    q.conn.execute("UPDATE candidates SET status='pending',result_json=?",(json.dumps(e),));q.conn.commit()
    if unsafe=='inactive_alias':
     alias={**review['lead'],'firm':'Other Alias Law'};q.add(alias)
     q.record(alias,{'status':'rejected_inactive','eligibility_hold':{'reason':'retired'}})
    q.close()
    out=apply(root)
    self.assertEqual(out.get('operator_reviews_restored',0),int(unsafe=='none'))
    self.assertEqual(apply(root).get('operator_reviews_restored',0),0)
