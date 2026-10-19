import tempfile,unittest
from pathlib import Path
from law_local.wsba_source import SEED,contact,discover,permitted
from law_local.worker import SqliteQueue,evaluate_candidate

def profile(size='Law firm with 1 WSBA member',status='Active',site=''):
 values={'lblStatus':status,'lblEligibleToPractice':'Yes','lblLicenseType':'Lawyer','lblAddCompanyName':'Fixture Law PLLC','lblEmployer':'Fixture Law PLLC','lblAddress':'Seattle, WA 98101 United States','lblPhone':'206-422-1836','lblEmail':'lawyer@fixture.example','lblFirmSize':size}
 return ''.join('<span id="dnn_'+k+'">'+v+'</span>' for k,v in values.items())+'<a id="dnn_hlWebsite" href="'+site+'">Visit website</a>'
class WsbaTests(unittest.TestCase):
 def test_count_optional_and_source_email_scoped_to_typed_field(self):
  for size in ('Law firm with 1 WSBA member','Law firm with 100+ WSBA members','Sole practitioner','','Unknown'):
   h=profile(size)+'<footer>unrelated@footer.example</footer>'
   lead,why=contact(SEED,h);self.assertEqual(why,'candidate')
   self.assertEqual(lead['emails'],['lawyer@fixture.example'])
   result=evaluate_candidate(lead,h,[{'provider':'one','responded':True,'urls':[]},{'provider':'two','responded':True,'urls':[]}],lambda _:True)
   self.assertEqual(result['status'],'strict_eligible');self.assertEqual(result['email'],'lawyer@fixture.example')
 def test_owned_site_inactive_and_government_fail_closed(self):
  h=profile(site='https://fixture-law.example/')
  lead,why=contact(SEED,h)
  self.assertEqual(evaluate_candidate(lead,h,[],lambda _:True)['status'],'review_website')
  self.assertIsNone(contact(SEED,profile(status='Inactive'))[0])
  self.assertIsNone(contact(SEED,profile(size='Government'))[0])
  self.assertIsNone(contact(SEED,profile().replace('United States','Canada'))[0])
 def test_only_returned_public_profile_urls_and_checkpointed_queries(self):
  with tempfile.TemporaryDirectory() as root:
   q=SqliteQueue(Path(root)/'test.db');calls=[]
   def fetch(url,timeout=8):calls.append(url);return profile()
   def search(query):return {'responded':True,'urls':['https://evil.example/?Usr_ID=123',SEED]}
   first=discover(q,fetch,search,max_queries=1)
   self.assertEqual(first['candidates_added'],1);self.assertEqual(calls,[SEED]);self.assertEqual(q.counts()['strict_eligible'],0)
   second=discover(q,fetch,search,max_queries=1)
   self.assertEqual(second['profiles_fetched'],0);self.assertEqual(calls,[SEED]);q.close()
   self.assertFalse(permitted('http://www.mywsba.org/PersonifyEbusiness/Default.aspx?TabID=1538&Usr_ID=123'))
if __name__=='__main__':unittest.main()
