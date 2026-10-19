"""Regression for modern provider-structured historical website holds."""
import tempfile
import unittest
from pathlib import Path
from law_local.worker import SqliteQueue
from ops.local_law.import_site_reviews import import_reviews
from ops.local_law.test_import_site_reviews import fixture


class ModernProviderHoldTests(unittest.TestCase):
    def test_historical_provider_urls_all_require_explicit_operator_dispositions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'leads.sqlite3'
            review = fixture()
            lead = review['lead']
            queue = SqliteQueue(path)
            self.assertTrue(queue.add(lead))
            held_urls = ('https://different-lawyer.example/practice',
                         'https://other-directory.example/attorney')
            queue.record(lead, {'status':'review_website', 'site_status':'review_website',
                                'site_evidence':{'providers':[
                                    {'provider':'searxng:google cse', 'urls':[held_urls[0]]},
                                    {'provider':'searxng:yep', 'urls':[held_urls[1]]}]}})
            queue.close()
            with self.assertRaisesRegex(ValueError, 'unresolved website candidates'):
                import_reviews(path, [review])
            for provider, url in zip(review['providers'], held_urls):
                provider['results'].append({'url':url,'relevant':False,
                    'disposition':'unrelated', 'note':'Reviewed separately: another principal and practice.'})
            self.assertEqual(import_reviews(path, [review])['new_verified'], 1)


if __name__ == '__main__':
    unittest.main()
