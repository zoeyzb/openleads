import json,unittest
from law_local.structured_search import brave_search
class StructuredSearchTests(unittest.TestCase):
 def test_no_key_is_not_a_negative_search(self):
  self.assertFalse(brave_search('test',key='')['responded'])
 def test_structured_positive_link(self):
  got=brave_search('test',key='fixture',fetch=lambda u,h,t:json.dumps({'web':{'results':[{'url':'https://example.org/'},{'url':'https://example.org/'}]}}))
  self.assertEqual(got['urls'],['https://example.org/'])
  self.assertTrue(got['responded'])
 def test_nonsearch_json_fails_closed(self):
  self.assertFalse(brave_search('test',key='fixture',fetch=lambda u,h,t:'{"message":"quota exceeded"}')['responded'])
 def test_invalid_json_fails_closed(self):
  self.assertFalse(brave_search('test',key='fixture',fetch=lambda u,h,t:'<html>blocked</html>')['responded'])
if __name__=='__main__':unittest.main()

class IntegratedStructuredSearchTests(unittest.TestCase):
 def test_configured_brave_replaces_bing_but_not_ddg(self):
  import os
  from unittest.mock import patch
  from law_local.worker import search_for_firm
  lead={'firm':'Some Example Law LLC','city':'Austin','state':'TX'}
  ddg='<html><body>duckduckgo <div class="result__a">Some Example Law LLC</div><a href="https://lawyer.com/firm/example.html">Some Example Law LLC</a></body></html>'
  with patch.dict(os.environ,{'BRAVE_SEARCH_API_KEY':'fixture'}), \
       patch('law_local.structured_search.brave_search',return_value={'responded':True,'urls':['https://examplelaw.com/']}), \
       patch('law_local.worker.fetch_public',return_value=ddg) as fetch:
   results=search_for_firm(lead)
  self.assertEqual(len(results),2)
  self.assertEqual(results[0]['urls'],['https://examplelaw.com/'])
  self.assertIn('duckduckgo.com',fetch.call_args.args[0])
