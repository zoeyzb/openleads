import unittest
import tempfile
from pathlib import Path
from law_local.worker import evaluate_candidate

def profile(firm='Fixture Law LLC',level='Attorney Member (Regular)',site=''):
    fields={'Membership level':level,'First Name':'Jane','Last Name':'Fixture','Firm':firm,'Email':'jane@fixture.example','Phone':'312-422-1836','ZIP':'60601','Website':site}
    return ''.join('<div class="fieldLabel"><span>'+k+'</span></div><div class="fieldBody"><span>'+v+'</span></div>' for k,v in fields.items())+'<footer>wrong@footer.example</footer>'

class IrelaTests(unittest.TestCase):
    def test_exact_profile_fields_ignore_footer(self):
        from law_local.irela_source import contact
        lead,reason=contact('https://irela.org/Sys/PublicProfile/123',profile())
        self.assertEqual(reason,'candidate');self.assertEqual(lead['emails'],['jane@fixture.example'])
        evidence=evaluate_candidate(lead,profile(),[{'provider':'one','responded':True,'urls':[]},{'provider':'two','responded':True,'urls':[]}],lambda _:True)
        self.assertEqual(evidence['status'],'strict_eligible')

    def test_sponsors_nonlaw_retired_and_bad_zip_rejected(self):
        from law_local.irela_source import contact
        url='https://irela.org/Sys/PublicProfile/123'
        for h in [profile(level='Corporate Sponsor - Gold'),profile(level='Retired Attorney Member'),profile(firm='First American Title Insurance Company'),profile().replace('60601','90210')]:
            self.assertIsNone(contact(url,h)[0])

    def test_site_candidate_and_email_in_website_field(self):
        from law_local.irela_source import contact
        url='https://irela.org/Sys/PublicProfile/123'
        lead,_=contact(url,profile(site='https://firm.example/'))
        self.assertEqual(lead['website_candidates'],['https://firm.example/'])
        lead,_=contact(url,profile(site='jane@fixture.example'))
        self.assertEqual(lead['website_candidates'],[])

    def test_profile_url_scope(self):
        from law_local.irela_source import permitted
        self.assertTrue(permitted('https://irela.org/Sys/PublicProfile/123'))
        for u in ['https://evil.example/Sys/PublicProfile/123','https://irela.org/Sys/PublicProfile/123?next=evil','https://irela.org/Sys/Login','http://irela.org/Sys/PublicProfile/123']:
            self.assertFalse(permitted(u))

class IrelaPolitenessTests(unittest.TestCase):
    def test_shared_rate_slot_cache_and_robots_denial(self):
        from law_local.irela_source import fetch_profile, ROBOTS
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'law.db';clock=[1000.0];calls=[]
            url='https://irela.org/Sys/PublicProfile/123'
            def fetch(target,timeout=9):
                calls.append(target)
                return 'User-agent: *\nDisallow: /Sys/Login\nRequest-rate: 1/60\nCrawl-delay: 10' if target==ROBOTS else profile()
            with self.assertRaises(OSError):fetch_profile(url,path,fetch,lambda:clock[0])
            self.assertEqual(calls,[ROBOTS])
            clock[0]+=61
            self.assertEqual(fetch_profile(url,path,fetch,lambda:clock[0]),profile())
            self.assertEqual(fetch_profile(url,path,fetch,lambda:clock[0]),profile())
            self.assertEqual(calls,[ROBOTS,url])
            with self.assertRaises(OSError):fetch_profile(url+'4',path,fetch,lambda:clock[0])
        with tempfile.TemporaryDirectory() as root:
            def deny(target,timeout=9):return 'User-agent: *\nDisallow: /Sys/PublicProfile/'
            with self.assertRaises(OSError):fetch_profile(url,Path(root)/'law.db',deny,lambda:1000.0)

if __name__=='__main__':unittest.main()
