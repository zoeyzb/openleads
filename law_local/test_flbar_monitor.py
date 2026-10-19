import unittest
from datetime import datetime,timezone
from law_local.flbar_monitor import contact,allowed_profile,export_proof_matches
from law_local.worker import evaluate_candidate,classify_search_results,firm_identity_matches

class MonitorTests(unittest.TestCase):
    def setUp(self):
        self.lead={'firm':'Example Quinn Law','phone':'8505669318','city':'Hosford','state':'FL',
            'source_url':'https://floridabarmonitor.com/attorney/123-example-quinn'}
        self.raw=('<h1>Example Quinn</h1>Florida Bar #123 '
            'Currently licensed and eligible to practice law in Florida. '
            'Last successful check: <!-- -->18 Oct 2026'
            '<dl><dt>Firm</dt><dd>Example Quinn Law</dd>'
            '<dt>Position</dt><dd>Private Law Practice</dd>'
            '<dt>City</dt><dd>Hosford, Liberty County</dd>'
            '<dt>Business phone</dt><dd>850-566-9318</dd>'
            '<dt>Website</dt><dd>—</dd></dl>')
        self.now=datetime(2026,10,19,tzinfo=timezone.utc)
    def parse(self,raw=None,lead=None):
        return contact(raw or self.raw,lead or self.lead,now=self.now)
    def test_current_private_exact_contact(self):
        self.assertTrue(self.parse()['fl_private_contact']['private_practice_confirmed'])
        self.assertTrue(firm_identity_matches(self.raw,self.lead))
    def test_inactive_stale_future_and_wrong_phone_fail(self):
        for old,new in [('Currently licensed and eligible','Previously licensed and eligible'),
            ('18 Oct 2026','01 Oct 2026'),('18 Oct 2026','20 Oct 2026'),
            ('850-566-9318','850-566-9319'),('Florida Bar #123','Florida Bar #999'),
            ('Private Law Practice','Government Attorney')]:
            with self.subTest(new=new):self.assertIsNone(self.parse(self.raw.replace(old,new)))
    def test_scope_rejects_search_api_auth_and_wrong_state(self):
        for path in ['/api/attorney/123','/attorneys?q=Quinn','/attorney/123-example-quinn?q=x','/go/123']:
            self.assertFalse(allowed_profile('https://floridabarmonitor.com'+path))
        self.assertIsNone(self.parse(lead={**self.lead,'state':'GA'}))
    def test_solo_uses_principal_without_inventing_company(self):
        raw=self.raw.replace('<dd>Example Quinn Law</dd>','<dd>—</dd>')
        self.assertIsNotNone(self.parse(raw,{**self.lead,'firm':'Example Quinn'}))
        self.assertIsNone(self.parse(raw))
    def test_any_nonblank_website_hint_remains_hold(self):
        for value in ['https://example.com','https:// [email protected]','']:
            got=self.parse(self.raw.replace('<dd>—</dd>','<dd>'+value+'</dd>'))
            self.assertTrue(got['website_candidates'])
    def test_monitor_and_alumni_are_third_parties(self):
        providers=[{'responded':True,'urls':['https://floridabarmonitor.com/attorney/123-example-quinn']},
            {'responded':True,'urls':['https://alumnius.net/university_of_florid-8124-5']}]
        self.assertEqual(classify_search_results(providers)['status'],'screened_no_site')
        providers[1]['urls'].append('https://examplequinnlaw.com')
        self.assertEqual(classify_search_results(providers)['status'],'review_website')
    def test_directory_source_still_requires_both_searches(self):
        result=evaluate_candidate(self.lead,self.raw,[],lambda _:False)
        self.assertEqual(result['status'],'inconclusive')
    def test_export_proof_rejects_phone_mismatch(self):
        proof=self.parse()
        self.assertTrue(export_proof_matches(self.lead,proof))
        self.assertFalse(export_proof_matches({**self.lead,'phone':'8505669319'},proof))
