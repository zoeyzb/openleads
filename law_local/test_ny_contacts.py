import json,tempfile,unittest
from pathlib import Path
from law_local import ny_contacts as ny
from law_local.worker import SqliteQueue,evaluate_candidate,firm_identity_matches

LEAD={'firm':"O'Brien Law PC",'phone':'2124221836','state':'NY','city':'NEW YORK'}
LEAD['source_url']=ny.source_url(LEAD)
ROW={'company_name':LEAD['firm'],'phone_number':'(212) 422-1836','city':'NEW YORK',
     'state':'NY','status':'Currently registered'}
SOURCES=[{'provider':p,'responded':True,'urls':['https://www.lawyers.com/example-ob-law']}
         for p in ('searxng:yandex','searxng:yep')]

class NYContactTests(unittest.TestCase):
    def test_scoped_current_contact_and_literal_company_query(self):
        self.assertTrue(ny.valid_source(LEAD['source_url'],LEAD))
        self.assertEqual(ny.scoped_contact(json.dumps([ROW]),LEAD)['official_contact']['phone'],LEAD['phone'])
        self.assertIn("company_name%3D%27O%27%27Brien",LEAD['source_url'])
    def test_other_contact_inactive_and_wrong_phone_never_bind(self):
        for change in ({'status':'Retired'},{'phone_number':'2124229999'},
                       {'company_name':'Other Law PC'},{'state':'CA'},{'city':'BUFFALO'}):
            self.assertIsNone(ny.scoped_contact(json.dumps([{**ROW,**change}]),LEAD))
    def test_source_url_and_ambiguous_employer_fail_closed(self):
        for url in (LEAD['source_url']+'&$limit=1000',
                    LEAD['source_url'].replace('data.ny.gov','evil.example'),
                    LEAD['source_url'].replace('eqw2-r5nb','other-table')):
            self.assertIsNone(ny.scoped_contact(json.dumps([ROW]),{**LEAD,'source_url':url}))
        for label in ('Records Music LLP','New York Law Department','District Attorney Office',
                      'ABC Holdings LLC','Attorney','Law Office','32BJ Legal Services Fund'):
            self.assertFalse(ny.private_practice_label(label),label)
    def test_canonical_qualification_requires_scoped_source_and_site_evidence(self):
        raw=json.dumps([ROW]);self.assertTrue(firm_identity_matches(raw,LEAD))
        result=evaluate_candidate(LEAD,raw,SOURCES,lambda _:False)
        self.assertEqual(result['status'],'call_qualified_no_email')
        self.assertTrue(SqliteQueue._verified_for_export(LEAD,result,result['status']))
        result['official_contact']['phone']='2124229999'
        self.assertFalse(SqliteQueue._verified_for_export(LEAD,result,result['status']))
        blocked=evaluate_candidate(LEAD,raw,[{**p,'responded':False} for p in SOURCES],lambda _:False)
        self.assertEqual(blocked['status'],'inconclusive')
        owned=evaluate_candidate(LEAD,raw,[{**SOURCES[0],'urls':['https://ob-law.example/']},SOURCES[1]],lambda _:False)
        self.assertEqual(owned['status'],'review_website')
    def test_staging_deduplicates_phone_and_never_qualifies(self):
        from law_local.ny_roster import ensure
        with tempfile.TemporaryDirectory() as folder:
            q=SqliteQueue(Path(folder)/'q.db');ensure(q)
            for i,company in enumerate((LEAD['firm'],'Alias Law Firm','Music Records LLP')):
                q.conn.execute('INSERT INTO ny_registration_groups VALUES (?,?,?,?,?,?,?,?,?)',
                    (str(i),company,LEAD['phone'],'NEW YORK','NY',1,'https://data.ny.gov',
                     'possible_private_law_firm','2026-10-19'))
            q.conn.commit()
            self.assertEqual(ny.stage(q,20,acquire=False)['added_unverified'],1)
            self.assertEqual(ny.stage(q,20,acquire=False)['added_unverified'],0)
            self.assertEqual(q.counts()['calling_qualified'],0);q.close()
