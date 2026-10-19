"""Non-law employers must fail private-practice verification before site searches."""
import unittest
from unittest.mock import patch
from law_local.worker import evaluate_candidate, process_candidate

class EmployerGateTests(unittest.TestCase):
    def test_known_nonlaw_directory_employers_cannot_be_qualified(self):
        names=('Mayo Clinic', 'Medtronic', 'Holiday Inn Club Vacations',
               'American Express', 'Siemens Gamesa Renewable Energy')
        for firm in names:
            with self.subTest(firm=firm):
                lead={'firm':firm,'phone':'3057030274',
                      'source_url':'https://www.floridalawdirectory.com/firm/placeholder'}
                html=f'<h1>{firm}</h1>Phone: 305-703-0274'
                good=[{'provider':'a','responded':True,'urls':[]},
                      {'provider':'b','responded':True,'urls':[]}]
                got=evaluate_candidate(lead,html,good,lambda _:True)
                self.assertEqual(got['status'],'review_nonlaw_employer')

    def test_obvious_employer_is_skipped_before_expensive_site_search(self):
        lead={'firm':'Mayo Clinic','phone':'3057030274',
              'source_url':'https://www.floridalawdirectory.com/firm/mayo-clinic'}
        with patch('law_local.worker.fetch_public',return_value='Mayo Clinic Phone: 305-703-0274'),\
             patch('law_local.worker.search_for_firm') as search:
            got=process_candidate(lead)
        self.assertEqual(got['status'],'review_nonlaw_employer')
        search.assert_not_called()

    def test_assistant_district_attorney_is_not_private_law_employer(self):
        from law_local.worker import clearly_non_private_practice
        self.assertTrue(clearly_non_private_practice(
            "Caroline E Hemphill, Franklin Parish Assistant District Attorney"))
        self.assertTrue(clearly_non_private_practice("State Attorney's Office"))
        self.assertFalse(clearly_non_private_practice("Cahill Law Office"))

    def test_generic_attorney_title_is_not_an_identified_practice(self):
        from law_local.worker import firm_identity_matches, SqliteQueue, utc_now
        for title in ("Attorney", "Law Office", "Law Firm", "Attorneys at Law"):
            with self.subTest(title=title):
                lead={'firm':title,'phone':'8505589917',
                      'source_url':'https://www.floridalawdirectory.com/firm/attorney'}
                html=f"{title} Phone: 850-558-9917"
                self.assertFalse(firm_identity_matches(html,lead))
                evidence={'firm':title,'phone':'8505589917','status':'call_qualified_no_email',
                          'checked_at':utc_now(),'source_url':lead['source_url'],
                          'site_status':'screened_no_site',
                          'qualification_scope':'law_no_owned_website_any_size',
                          'site_evidence':{'providers':[{'provider':'a','responded':True},
                                                       {'provider':'b','responded':True}]}}
                self.assertFalse(SqliteQueue._verified_for_export(lead,evidence,'call_qualified_no_email'))

    def test_named_law_practice_is_not_excluded(self):
        lead={'firm':'Mayo Law Group','phone':'3057030274',
              'source_url':'https://www.lawyer.com/firm/mayo-law-group.html'}
        good=[{'provider':'a','responded':True,'urls':[]},
              {'provider':'b','responded':True,'urls':[]}]
        got=evaluate_candidate(lead,'Mayo Law Group 305-703-0274',good,lambda _:True)
        self.assertEqual(got['status'],'call_qualified_no_email')

if __name__=='__main__': unittest.main()
