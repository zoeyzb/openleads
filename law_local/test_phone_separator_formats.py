"""A verified public directory telephone may use a slash as a separator."""
import unittest
from law_local.worker import firm_identity_matches, normalize_phone

class PublicPhoneSeparatorTests(unittest.TestCase):
    def test_slash_separated_typed_business_phone_matches(self):
        firm = "Terpinas Law Group, LLC"
        source_html = '<div>Terpinas Law Group, LLC</div><div>Phone: 847/910-6456</div>'
        self.assertTrue(firm_identity_matches(source_html, {
            "firm": firm, "phone": normalize_phone("847/910-6456")
        }))

    def test_phone_cannot_be_fabricated_from_unrelated_digits(self):
        html = '<div>Firm: Sample Law Group</div><div>Suite 847</div><div>ZIP 91064</div><div>2018</div>'
        self.assertFalse(firm_identity_matches(html, {
            "firm": "Sample Law Group", "phone": "8479106456"
        }))

if __name__ == "__main__":
    unittest.main()
