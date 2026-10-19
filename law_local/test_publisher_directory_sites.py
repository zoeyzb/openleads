"""Independent publisher URLs cannot be mislabelled as the lead's owned domain."""
import unittest
from law_local.worker import _third_party, classify_search_results


class PublisherDirectoryTests(unittest.TestCase):
    EXTERNAL = (
        'https://attorneys.lexinter.net/lawyer/jane-doe',
        'https://lawtally.com/lawyers/jane-doe/',
        'https://www.attorneyatlaw.com/lawyer/jane-doe',
        'https://lawyers.onecle.com/lawyer/jane-doe',
        'https://www.pacermonitor.com/public/case/123/jane-doe',
    )

    def test_verified_external_publisher_hosts(self):
        for url in self.EXTERNAL:
            with self.subTest(url=url):
                from urllib.parse import urlparse
                self.assertTrue(_third_party(urlparse(url).hostname))

    def test_other_unknown_hosts_and_attributable_site_remain_holds(self):
        for host in ('jane-doe-law.com','mytexasdefenselawyer.com',
                     'not-onecle.com','legalmarketing-hosted.example'):
            with self.subTest(host=host):
                self.assertFalse(_third_party(host))
        checks=[{'responded':True,'urls':[self.EXTERNAL[0]]},
                {'responded':True,'urls':[self.EXTERNAL[1]]}]
        self.assertEqual(classify_search_results(checks)['status'],'screened_no_site')
        checks[1]['urls'].append('https://jane-doe-law.com')
        self.assertEqual(classify_search_results(checks)['status'],'review_website')

if __name__ == '__main__':unittest.main()
