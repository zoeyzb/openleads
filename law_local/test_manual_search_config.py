import unittest
from law_local.worker import configure_search_defaults

class SearchConfigurationTests(unittest.TestCase):
    def test_mac_manual_worker_matches_existing_local_hourly_campaign(self):
        variables={}
        configure_search_defaults('run','darwin',variables)
        self.assertEqual(variables.get('OPENLEADS_SEARCH_MODE'),'local_forks')
    def test_explicit_provider_selection_is_preserved(self):
        variables={'OPENLEADS_SEARCH_MODE':'public'}
        configure_search_defaults('run','darwin',variables)
        self.assertEqual(variables['OPENLEADS_SEARCH_MODE'],'public')
    def test_other_platforms_and_non_research_commands_unchanged(self):
        for cmd,osname in (('run','win32'),('stats','darwin'),('export','darwin')):
            values={}
            configure_search_defaults(cmd,osname,values)
            self.assertNotIn('OPENLEADS_SEARCH_MODE',values)
if __name__=='__main__':unittest.main()
