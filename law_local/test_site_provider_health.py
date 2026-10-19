"""Probing search status is not a license to infer website absence."""
import unittest
from law_local.site_provider_health import audit_provider_health

class SiteProviderHealthTests(unittest.TestCase):
    def test_both_providers_plus_known_owned_domain(self):
        ok=audit_provider_health(lambda control:[
            {"provider":"searxng:google cse","responded":True,"urls":["https://www.axslawgroup.com/"]},
            {"provider":"searxng:yep","responded":True,"urls":["https://axslawgroup.com/"]}
        ])
        self.assertEqual(ok["status"],"usable")
        self.assertTrue(ok["positive_control_found"])
    def test_one_control_pass_cannot_mask_other_provider_failure(self):
        result=audit_provider_health(lambda control:[
            {"responded":True,"urls":["https://axslawgroup.com/"]},
            {"responded":True,"urls":[]}
        ])
        self.assertEqual(result["status"],"degraded")
        self.assertFalse(result["provider_details"][1]["positive_control_found"])
    def test_both_http_ok_but_offtopic_invalid(self):
        result=audit_provider_health(lambda control:[
            {"responded":True,"urls":["https://dan.org/","https://reubensbrews.com/"]},
            {"responded":True,"urls":[]}
        ])
        self.assertEqual(result["status"],"degraded")
    def test_duckduckgo_bot_202_blocks_without_negative_site_claim(self):
        result=audit_provider_health(lambda control:[
            {"responded":True,"urls":["https://axslawgroup.com/"]},
            {"responded":False,"urls":[]}
        ])
        self.assertEqual(result["status"],"degraded")
    def test_no_responses_blocks(self):
        self.assertEqual(audit_provider_health(lambda c:[])["status"],"degraded")

    def test_outage_diagnostics_preserve_provider_and_backoff(self):
        out=audit_provider_health(lambda c:[{"provider":"brave_public","responded":False,"urls":[],"reason":"provider_cooldown","http_status":429,"retry_after_seconds":21600}])
        detail=out["provider_details"][0]
        self.assertEqual(detail["provider"],"brave_public")
        self.assertEqual(detail["http_status"],429)
        self.assertEqual(detail["retry_after_seconds"],21600)
        self.assertEqual(out["status"],"degraded")

    def test_duplicate_engine_and_unattributed_control_cannot_verify_absence(self):
        for labels in (("searxng:yep", "searxng:yep"), (None, "searxng:yep")):
            result = audit_provider_health(lambda _: [
                {"provider":label,"responded":True,"urls":["https://axslawgroup.com/"]}
                for label in labels])
            self.assertEqual(result["status"],"degraded")

    def test_live_preflight_does_not_spend_peer_quota_on_known_rate_limit(self):
        from unittest.mock import patch
        from law_local.site_provider_health import control_sources, CONTROL
        with patch.dict('os.environ', {'OPENLEADS_SEARCH_MODE':'local_forks'}), \
             patch('law_local.free_search._cooldown_remaining', side_effect=lambda e: 600 if e=='google cse' else 0), \
             patch('law_local.free_search.candidate_search') as request:
            sources=control_sources(CONTROL)
        self.assertEqual(sources[0]['reason'],'provider_cooldown')
        self.assertEqual(sources[1]['reason'],'skipped_peer_cooldown')
        request.assert_not_called()

    def test_local_control_avoids_supplemental_alias_requests(self):
        from unittest.mock import patch
        from law_local.site_provider_health import control_sources,CONTROL
        with patch.dict('os.environ',{'OPENLEADS_SEARCH_MODE':'local_forks'}), \
             patch('law_local.free_search._cooldown_remaining',return_value=0), \
             patch('law_local.free_search.candidate_search',return_value={'responded':True}) as search:
            self.assertEqual(len(control_sources(CONTROL)),2)
            self.assertEqual(search.call_count,2)
