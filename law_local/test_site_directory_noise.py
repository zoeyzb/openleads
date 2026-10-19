"""Directory/editorial search hits are not evidence of an owned law-firm site."""
import unittest
from law_local.worker import classify_search_results

class DirectoryNoiseTests(unittest.TestCase):
    def test_directory_and_editorial_hits_do_not_force_site_review(self):
        providers = [
            dict(provider="searxng:yandex", responded=True, urls=[
                "https://lawyers.lawyerlegion.com/firm/fixture",
                "https://chambers.com/firm/fixture"]),
            dict(provider="searxng:yep", responded=True, urls=[
                "https://en.wikipedia.org/wiki/Fixture",
                "https://checkmyattorney.com/fixture",
                "https://linktr.ee/fixture"]),
        ]
        self.assertEqual(classify_search_results(providers)["status"], "screened_no_site")

    def test_unknown_site_must_still_be_held_for_review(self):
        providers = [
            dict(provider="searxng:yandex", responded=True, urls=[
                "https://fixturelawgroup.com/"]),
            dict(provider="searxng:yep", responded=True, urls=[
                "https://chambers.com/firm/fixture"]),
        ]
        self.assertEqual(classify_search_results(providers)["status"], "review_website")

    def test_no_negative_site_proof_when_provider_unavailable(self):
        providers = [
            dict(provider="searxng:yandex", responded=True, urls=[
                "https://chambers.com/firm/fixture"]),
            dict(provider="searxng:yep", responded=False, urls=[]),
        ]
        self.assertEqual(classify_search_results(providers)["status"], "inconclusive")

if __name__ == "__main__":
    unittest.main()
