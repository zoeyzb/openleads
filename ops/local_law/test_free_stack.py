import unittest
from unittest.mock import patch
from ops.local_law import free_stack

class ForkStackTests(unittest.TestCase):
    def test_all_five_owned_forks_registered(self):
        self.assertEqual(set(free_stack.FORKS),{'searxng','yacy','maps','stormcrawler','cdx_toolkit'})
        self.assertTrue(all('zoeyzb/' in p['repo'] for p in free_stack.FORKS.values()))
    def test_positive_only_yacy_and_archive(self):
        self.assertEqual(free_stack.FORKS['yacy']['kind'],'positive_only')
        self.assertEqual(free_stack.FORKS['cdx_toolkit']['kind'],'historical_positive_only')
        self.assertEqual(free_stack.FORKS['maps']['kind'],'research_only')
    def test_probe_never_changes_env(self):
        fake={'status':'degraded','positive_control_found':False}
        with patch.dict('os.environ',{},clear=True), patch('law_local.site_provider_health.audit_provider_health',return_value=fake):
            receipt=free_stack.probe()
            self.assertEqual(receipt['qualification_gate'],'blocked')
            import os
            self.assertNotIn('OPENLEADS_SEARCH_MODE',os.environ)
    def test_java_missing_not_ready(self):
        from subprocess import CompletedProcess
        fake=lambda *a,**kw:CompletedProcess(a[0],1,'','Java Runtime not found')
        self.assertIsNone(free_stack.installed_java_major(runner=fake))
    def test_cdx_without_optional_package_reports_not_installed(self):
        with patch('importlib.util.find_spec',return_value=None):
            result=free_stack.cdx_hints('lawyer.com/firm/example*')
            self.assertEqual(result['urls'],[])
            self.assertEqual(result['status'],'not_installed')

if __name__=='__main__':unittest.main()
