import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from law_local.worker import domain_has_mail, SqliteQueue, discovery_queries
from law_local.wsba_source import discover

class VerificationRepairTests(unittest.TestCase):
    def test_null_mx_and_malformed_exchangers_rejected(self):
        for answer in ('fixture.test mail exchanger = 0 .\n',
                       'fixture.test mail exchanger = 0\n',
                       'fixture.test mail exchanger = 0 invalid\n'):
            with self.subTest(answer=answer), patch('law_local.worker.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout=answer)):
                self.assertFalse(domain_has_mail('fixture.test'))

    def test_real_mx_accepted_and_command_failure_rejected(self):
        for code, expected in ((0, True), (1, False)):
            with patch('law_local.worker.subprocess.run', return_value=SimpleNamespace(returncode=code, stdout='fixture.test mail exchanger = 10 mx.mailhost.test.\n')):
                self.assertEqual(domain_has_mail('fixture.test'), expected)

    def test_failed_wsba_search_is_retryable(self):
        with tempfile.TemporaryDirectory() as root:
            q = SqliteQueue(Path(root)/'law.db')
            calls = []
            def search(query):
                calls.append(query)
                return {'responded':False,'urls':[]}
            with patch('law_local.wsba_source.CITIES',('Seattle',)):
                discover(q, fetch=lambda *a, **kw:'', search=search,max_queries=1)
                discover(q, fetch=lambda *a, **kw:'', search=search,max_queries=1)
            self.assertEqual(calls[0],calls[1])
            q.close()

    def test_unavailable_city_does_not_starve_new_cities(self):
        with tempfile.TemporaryDirectory() as root:
            q=SqliteQueue(Path(root)/'law.db');calls=[]
            def search(query):calls.append(query);return {'responded':False,'urls':[]}
            discover(q,fetch=lambda *a,**kw:'',search=search,max_queries=1)
            discover(q,fetch=lambda *a,**kw:'',search=search,max_queries=1)
            self.assertNotEqual(calls[0],calls[1]);q.close()

    def test_discovery_does_not_require_size_query(self):
        queries=list(discovery_queries(['FL']))
        self.assertFalse(any('firm size' in query for _, query in queries))

class QueuePriorityRepairTests(unittest.TestCase):
    def test_new_email_source_not_starved_by_inbar_retry(self):
        with tempfile.TemporaryDirectory() as root:
            q=SqliteQueue(Path(root)/'law.db')
            retry=dict(firm='Old Fixture Law',phone='3124221836',state='IL',source_url='https://www.inbar.org/members/default.asp?id=123')
            fresh=dict(firm='New Fixture Law',phone='3124221837',state='IL',source_url='https://irela.org/Sys/PublicProfile/123')
            q.add(retry);q.add(fresh)
            q.conn.execute("UPDATE candidates SET status='inconclusive',attempts=1,updated='2026-01-01T00:00:00+00:00' WHERE firm=?",(retry['firm'],));q.conn.commit()
            self.assertEqual(q.pending(1)[0]['firm'],fresh['firm']);q.close()

class EvidenceRetentionRepairTests(unittest.TestCase):
    def test_website_holds_retain_each_provider_observation(self):
        from law_local.worker import evaluate_candidate
        lead=dict(firm='Fixture Law',phone='3124221836',source_url='https://www.lawyer.com/firm/fixture-law.html')
        providers=[dict(provider='one',responded=True,urls=['https://fixture-law.example/']),dict(provider='two',responded=True,urls=['https://www.lawyer.com/firm/fixture-law.html'])]
        result=evaluate_candidate(lead,'Fixture Law Call 312-422-1836',providers,lambda _:True)
        self.assertEqual(result['status'],'review_website')
        self.assertEqual(len(result['site_evidence']['providers']),2)

if __name__ == '__main__':unittest.main()
