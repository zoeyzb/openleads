"""Probing search status is not a license to infer website absence."""
import unittest
from law_local.site_provider_health import audit_provider_health

class SiteProviderHealthTests(unittest.TestCase):
    def test_both_providers_plus_known_owned_domain(self):
        ok=audit_provider_health(lambda control:[
            {"responded":True,"urls":["https://www.axslawgroup.com/"]},
            {"responded":True,"urls":["https://axslawgroup.com/"]}
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
