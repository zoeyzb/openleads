"""Public HTML result parsing must fail closed when blocked or changed."""
import unittest
from law_local.public_brave import brave_public_search
from law_local.worker import search_result_relevant
LEAD={'firm':'AXS Law Group','city':'Miami','state':'FL'}

class BravePublicTests(unittest.TestCase):
    def test_real_card_not_navigation_or_echo(self):
        html='''<html><title>AXS Law Group - Brave Search</title>
          <a href="https://irrelevant.example">AXS Law Group</a>
          <div class="snippet svelte-test" data-pos="0" data-type="web">
            <div class="result-body"><a href="https://www.axslawgroup.com/">
              <div>AXS LAW Group</div><div>Home | AXS LAW Group</div></a></div>
          </div></html>'''
        out=brave_public_search(LEAD,search_result_relevant,
                                fetch_fn=lambda url,timeout:html)
        self.assertTrue(out['responded'])
        self.assertEqual(out['urls'],['https://www.axslawgroup.com/'])
    def test_http_success_or_irrelevant_card_is_not_negative_proof(self):
        for html in ('<html>AXS Law Group Brave Search</html>',
                     '<div class="snippet" data-type="web"><a href="https://unrelated.example">Unrelated Practice</a></div>'):
            out=brave_public_search(LEAD,search_result_relevant,
                                    fetch_fn=lambda url,timeout:html)
            self.assertFalse(out['responded'])
            self.assertEqual(out['urls'],[])
    def test_blocked_provider_fails_closed(self):
        def blocked(url,timeout):raise ValueError('HTTP 429')
        out=brave_public_search(LEAD,search_result_relevant,fetch_fn=blocked)
        self.assertFalse(out['responded'])
        self.assertEqual(out['reason'],'ValueError')
class ProviderBackoffTests(unittest.TestCase):
    def test_http_429_pauses_following_candidates_and_records_retry(self):
        import tempfile,time,json
        from pathlib import Path
        from law_local.public_brave import ProviderFetchError
        with tempfile.TemporaryDirectory() as d:
            state=Path(d)/"brave.json";calls=[]
            def blocked(url,timeout):
                calls.append(url)
                raise ProviderFetchError("http_429",429,36000)
            first=brave_public_search(LEAD,search_result_relevant,fetch_fn=blocked,state_path=state)
            second=brave_public_search({**LEAD,"firm":"Another Firm"},search_result_relevant,fetch_fn=blocked,state_path=state)
            self.assertEqual(first["reason"],"http_429")
            self.assertEqual(first["http_status"],429)
            self.assertEqual(second["reason"],"provider_cooldown")
            self.assertEqual(len(calls),1)
            self.assertGreater(json.loads(state.read_text())["retry_at"],time.time()+35000)
            self.assertFalse(second["responded"])

    def test_challenge_with_http_success_never_becomes_negative_evidence(self):
        import tempfile,json,time
        from pathlib import Path
        with tempfile.TemporaryDirectory() as d:
            state=Path(d)/"brave.json"
            result=brave_public_search(LEAD,search_result_relevant,fetch_fn=lambda url,timeout:'<html>Verify you are human CAPTCHA</html>',state_path=state)
            self.assertEqual(result["reason"],"access_challenge")
            self.assertFalse(result["responded"])
            self.assertGreater(json.loads(state.read_text())["retry_at"],time.time()+80000)

    def test_transport_error_is_distinct_from_rate_limit(self):
        import subprocess,tempfile
        from pathlib import Path
        from unittest.mock import patch
        from law_local.public_brave import fetch_brave_public,ProviderFetchError
        with patch('law_local.public_brave.subprocess.run',return_value=subprocess.CompletedProcess([],6,b'',b'private diagnostic')):
            with self.assertRaises(ProviderFetchError) as caught:fetch_brave_public('https://search.brave.com/search?q=control')
        self.assertEqual(caught.exception.reason,'transport_error_6')
        self.assertNotIn('private diagnostic',str(caught.exception))

if __name__=='__main__':unittest.main()
