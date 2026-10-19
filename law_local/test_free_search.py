import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse
from law_local import free_search
from law_local.worker import classify_search_results, search_for_firm

class FreeSearchTests(unittest.TestCase):
    def test_local_backend_ssrf_guard(self):
        for value in ("https://localhost:18888", "http://8.8.8.8:18888", "http://localhost:18888@evil.com", "http://localhost:18888/private", "http://localhost", "file:///private"):
            with self.subTest(url=value), self.assertRaises(ValueError):
                free_search.local_origin(value, 18888)
    def test_searx_per_engine_attribution_and_query(self):
        def response(url):
            p=parse_qs(urlparse(url).query)
            self.assertEqual(p['engines'],['bing'])
            self.assertEqual(p['format'],['json'])
            return {'results':[{'url':'https://real-firm.example/','engine':'bing','title':'Example Law'}, {'url':'https://other.example/','engine':'google','title':'Other'}], 'unresponsive_engines':[]}
        got=free_search.searx_engine('firm', 'bing', fetch=response)
        self.assertTrue(got['responded'])
        self.assertEqual(got['urls'],['https://real-firm.example/'])
    def test_searx_unresponsive_engine_cannot_be_negative(self):
        got=free_search.searx_engine('firm','google',fetch=lambda _: {'results':[], 'unresponsive_engines':[['google','captcha']]})
        self.assertFalse(got['responded'])
    def test_searx_malformed_json_fails_closed(self):
        got=free_search.searx_engine('firm','google',fetch=lambda _: {'unexpected':1})
        self.assertFalse(got['responded'])
    def test_yacy_positive_only_never_counted_as_second_negative(self):
        got=free_search.yacy_search('firm',fetch=lambda _: {'channels':[{'items':[{'link':'https://firm.example/'}]}]})
        self.assertFalse(got['responded'])
        self.assertEqual(got['urls'],['https://firm.example/'])
        self.assertEqual(classify_search_results([{'responded':True,'urls':[]},{'responded':False,'urls':[]},got])['status'],'review_website')
    def test_namesake_without_legal_context_is_not_website_proof(self):
        lead={'firm':'Adams James F','city':'Altoona','state':'PA'}
        data={'results':[{'url':'https://graves.example/cemetery/adams','engine':'yahoo',
                          'title':'James F Adams cemetery burial records'},
                         {'url':'https://lawyers.com/attorneys/adams','engine':'yahoo',
                          'title':'James F Adams attorney directory'}], 'unresponsive_engines':[]}
        out=free_search.searx_engine('Adams James','yahoo',fetch=lambda _:data,lead=lead)
        self.assertEqual(out['urls'],['https://lawyers.com/attorneys/adams'])

    def test_official_domain_with_name_but_without_law_keyword_survives(self):
        lead={'firm':'Culmer & Davidson','city':'Miami','state':'FL'}
        data={'results':[{'url':'https://culmerdavidson.com/','engine':'yahoo',
                          'title':'Culmer & Davidson'}], 'unresponsive_engines':[]}
        out=free_search.searx_engine('Culmer Davidson','yahoo',fetch=lambda _:data,lead=lead)
        self.assertTrue(out['responded'])
        self.assertEqual(out['urls'],['https://culmerdavidson.com/'])

    def test_direct_firm_domain_survives_generic_page_title(self):
        lead={'firm':'Culmer & Davidson','city':'Miami','state':'FL'}
        data={'results':[{'url':'https://culmerdavidson.com/','engine':'yahoo',
                          'title':'Welcome','content':''}], 'unresponsive_engines':[]}
        out=free_search.searx_engine('Culmer Davidson','yahoo',fetch=lambda _:data,lead=lead)
        self.assertEqual(out['urls'],['https://culmerdavidson.com/'])

    def test_www_firm_domain_is_not_lost_when_title_is_generic(self):
        lead={'firm':'Culmer & Davidson','city':'Miami','state':'FL'}
        data={'results':[{'url':'https://www.culmerdavidson.com/','engine':'yahoo',
                          'title':'Welcome','content':''}], 'unresponsive_engines':[]}
        out=free_search.searx_engine('Culmer Davidson','yahoo',fetch=lambda _:data,lead=lead)
        self.assertEqual(out['urls'],['https://www.culmerdavidson.com/'])

    def test_yacy_unrelated_hits_do_not_hold_as_possible_firm_site(self):
        lead={'firm':'AXS Law Group','city':'Miami','state':'FL'}
        payload={'channels':[{'items':[{'link':'https://unrelated.example/','title':'Miami nightlife'},
                                     {'link':'https://axslawgroup.com/','title':'AXS Law Group - Miami'}]}]}
        found=free_search.yacy_search('AXS',fetch=lambda _:payload,lead=lead)
        self.assertEqual(found['urls'],['https://axslawgroup.com/'])
        self.assertFalse(found['responded'])
    def test_searx_ignores_irrelevant_search_hits(self):
        lead={'firm':'AXS Law Group','city':'Miami','state':'FL'}
        data={'results':[{'url':'https://otherbusiness.example/','engine':'google','title':'Miami law jobs'},
                         {'url':'https://axslawgroup.com','engine':'google','title':'AXS Law Group'}],
              'unresponsive_engines':[]}
        result=free_search.searx_engine('AXS','google',fetch=lambda _:data,lead=lead)
        self.assertEqual(result['urls'],['https://axslawgroup.com'])

    def test_yacy_empty_index_cannot_qualify(self):
        got=free_search.yacy_search('firm',fetch=lambda _: {'channels':[{'items':[]}]})
        self.assertFalse(got['responded'])
        self.assertEqual(classify_search_results([{'responded':True,'urls':[]},got])['status'],'inconclusive')
    def test_default_local_pair_uses_independent_working_indexes(self):
        lead={'firm':'AXS Law Group','city':'Miami','state':'FL'}
        with patch.dict('os.environ', {'OPENLEADS_YACY_ENABLED':'0'}), patch('law_local.free_search.searx_engine', side_effect=lambda query,engine,lead=None: {'provider':'searxng:'+engine,'responded':True,'urls':[]} ) as engine:
            sources=free_search.search_firm(lead)
            self.assertEqual([x['provider'] for x in sources], ['searxng:yandex','searxng:yep'])
            self.assertEqual(engine.call_count,4)

    def test_truncated_source_name_does_not_hide_possible_owned_site(self):
        lead={'firm':'The Law Office of Kyle Thompso','state':'KY'}
        data={'results':[{'url':'https://actual-practice.example/','engine':'yandex',
                          'title':'Kyle Thompson, Attorney at Law'}]}
        out=free_search.searx_engine('Kyle Thompso lawyer','yandex',fetch=lambda _:data,lead=lead)
        self.assertEqual(out['urls'],['https://actual-practice.example/'])

    def test_phone_match_retains_renamed_practice_for_review(self):
        lead={'firm':'Old Practice Law Office','phone':'2142997700','state':'TX'}
        data={'results':[{'url':'https://renamed-law.example/','engine':'yandex',
                          'title':'Renamed Attorneys','content':'Contact 214-299-7700'}]}
        out=free_search.searx_engine('214-299-7700','yandex',fetch=lambda _:data,lead=lead)
        self.assertEqual(out['urls'],['https://renamed-law.example/'])

    def test_alias_queries_cannot_supply_missing_negative_provider(self):
        def response(query,engine,lead=None):
            if query.startswith('"'):
                return {'provider':'searxng:'+engine,'responded':False,'urls':[]}
            return {'provider':'searxng:'+engine,'responded':True,'urls':['https://owned.example/']}
        with patch('law_local.free_search.searx_engine',side_effect=response):
            got=free_search.search_firm({'firm':'Test Office Law','state':'TX'})
        self.assertFalse(got[0]['responded']);self.assertFalse(got[1]['responded'])
        self.assertFalse(got[-1]['responded']);self.assertEqual(got[-1]['provider'],'alias_phone_positive_only')

    def test_absent_attributed_search_hits_are_not_a_completed_negative(self):
        response={'results':[{'url':'https://unrelated.example/','engine':'bing','title':'Wrong search engine'}], 'unresponsive_engines':[]}
        got=free_search.searx_engine('firm','yahoo',fetch=lambda _:response)
        self.assertFalse(got['responded'])

    def test_echoed_empty_query_is_completed_negative_when_engine_preflight_healthy(self):
        # SearXNG returns this exact shape for zero-result queries in production.
        q='"unlisted-fictional-local-firm-x9q" law firm'
        payload={'query':q,'results':[], 'unresponsive_engines':[]}
        got=free_search.searx_engine(q,'yandex',fetch=lambda _:payload)
        self.assertTrue(got['responded'])
        self.assertEqual(got['urls'],[])
        self.assertEqual(classify_search_results([got,{**got,'provider':'searxng:yep'}])['status'],'screened_no_site')

    def test_empty_query_missing_echo_or_engine_health_fails_closed(self):
        q='"unlisted-fictional-local-firm-x9q" law firm'
        for payload in ({'results':[], 'unresponsive_engines':[]},
                        {'query':'another query','results':[], 'unresponsive_engines':[]},
                        {'query':q,'results':[]},
                        {'query':q,'results':[], 'unresponsive_engines':[['yandex','timeout']]}):
            with self.subTest(payload=payload):
                self.assertFalse(free_search.searx_engine(q,'yandex',fetch=lambda _:payload)['responded'])

    def test_requested_engine_result_with_irrelevant_legal_article_is_inconclusive(self):
        q='"unknown distinct firm" law firm'
        payload={'query':q,'results':[{'url':'https://news.example/irrelevant',
                 'engine':'yandex','title':'Unrelated legal news'}], 'unresponsive_engines':[]}
        got=free_search.searx_engine(q,'yandex',lead={'firm':'Unknown Distinct Firm'},fetch=lambda _:payload)
        self.assertFalse(got['responded'])
        self.assertEqual(got['urls'],[])

    def test_search_engine_error_fails_closed(self):
        response={'results':[{'url':'https://lawfirm.example/','engine':'yahoo','title':'Law Firm'}], 'unresponsive_engines':[['yahoo','HTTP 429']]}
        got=free_search.searx_engine('law firm','yahoo',fetch=lambda _:response)
        self.assertFalse(got['responded'])

    def test_opt_in_source_switch(self):
        lead={'firm':'Example Law','city':'Miami','state':'FL'}
        with patch.dict('os.environ', {'OPENLEADS_SEARCH_MODE':'local_forks'}), patch('law_local.free_search.search_firm',return_value=[{'provider':'example'}]) as checker:
            self.assertEqual(search_for_firm(lead),[{'provider':'example'}])
            checker.assert_called_once_with(lead)

if __name__=='__main__':unittest.main()

class CandidateRelevanceTests(unittest.TestCase):
    def test_irrelevant_hits_never_complete_candidate_negative(self):
        lead={'firm':'Example Quinn Law','state':'FL'}
        payload={'query':'exact query','results':[{'url':'https://unrelated.example/',
            'engine':'yep','title':'Florida weather'}],'unresponsive_engines':[]}
        result=free_search.searx_engine('exact query','yep',fetch=lambda _:payload,lead=lead)
        self.assertFalse(result['responded'])
        self.assertEqual(result['reason'],'no_relevant_candidate_results')

    def test_empty_candidate_search_never_establishes_absence(self):
        payload={'query':'exact query','results':[],'unresponsive_engines':[]}
        result=free_search.searx_engine('exact query','yep',fetch=lambda _:payload,
            lead={'firm':'Example Quinn Law'})
        self.assertFalse(result['responded'])

    def test_relevant_directory_completes_candidate_search_with_query(self):
        payload={'query':'exact query','results':[{'url':'https://lawyers.com/example-quinn',
            'engine':'yep','title':'Example Quinn Law Florida attorneys'}],'unresponsive_engines':[]}
        result=free_search.searx_engine('exact query','yep',fetch=lambda _:payload,
            lead={'firm':'Example Quinn Law'})
        self.assertTrue(result['responded'])
        self.assertEqual(result['query'],'exact query')

class ShortFirmPhoneRelevanceTests(unittest.TestCase):
    def test_short_practice_name_still_matches_exact_phone_and_legal_context(self):
        payload={'results':[{'url':'https://lawyers.com/dc-law-group','engine':'yep',
            'title':'DC Law Group lawyers (206) 494-0400'},
            {'url':'https://unrelated.example','engine':'yep','title':'Unrelated lawyers'}],
            'unresponsive_engines':[]}
        result=free_search.searx_engine('phone query','yep',fetch=lambda _:payload,
            lead={'firm':'DC Law Group','phone':'2064940400'})
        self.assertTrue(result['responded'])
        self.assertEqual(result['urls'],['https://lawyers.com/dc-law-group'])
