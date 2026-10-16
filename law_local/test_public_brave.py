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
if __name__=='__main__':unittest.main()
