"""Bar-source contact evidence stays separate from final qualified leads."""
import tempfile
import unittest
from pathlib import Path
from law_local.worker import SqliteQueue
from law_local.fl_bar_contacts import (
    parse_roster_member_ids,parse_bar_profile_contact,store_bar_contact_proof,
    contact_proof_totals
)

FIRM="Murray & Shepard Law LLC"
PHONE="(813) 422-1960"
FIRM_HTML='''<h1>Murray & Shepard Law LLC</h1><p>Attorneys 2 active</p>
<p>Phone (813) 422-1960</p><h2>Active attorneys (2)</h2>
<a href="/attorney/bertha-murray-321456">Bertha Murray</a>
<a href="/attorney/james-shepard-765432">James Shepard</a>'''
BAR_HTML='''<h1>Bertha Murray</h1>
<div>Mail Address: Murray & Shepard Law LLC</div>
<div>Office: 813-422-1960</div>
<div>Email: <a href="mailto:bertha.murray@businessmail.org">bertha.murray@businessmail.org</a></div>
<div>Firm: Murray & Shepard Law LLC</div>
<div>Firm Size: 2-5</div>'''
SITE_HTML=BAR_HTML+'<div>Firm Website: https://murrayandshepard.com</div>'

class ContactEvidenceTests(unittest.TestCase):
    def test_exact_published_attorney_identifiers_only(self):
        self.assertEqual(parse_roster_member_ids(FIRM_HTML),["321456","765432"])
        self.assertEqual(parse_roster_member_ids("<a href='/attorney/no-id'>Person</a>"),[])

    def test_bar_published_email_binds_to_firm_and_office_phone(self):
        r=parse_bar_profile_contact(BAR_HTML,FIRM,PHONE,"321456")
        self.assertEqual(r["status"],"published_mx_pending")
        self.assertEqual(r["email"],"bertha.murray@businessmail.org")
        self.assertEqual(r["email_source"],
                         "https://www.floridabar.org/directories/find-mbr/profile/?num=321456")
        self.assertEqual(r["website"],"")

    def test_office_phone_mismatch_never_accepts_email(self):
        r=parse_bar_profile_contact(BAR_HTML.replace("813-422-1960","813-422-1999"),
                                    FIRM,PHONE,"321456")
        self.assertEqual(r["status"],"identity_mismatch")
        self.assertEqual(r["email"],"")

    def test_firm_mismatch_never_accepts_email(self):
        r=parse_bar_profile_contact(BAR_HTML.replace(FIRM,"Outside Firm"),FIRM,PHONE,"321456")
        self.assertEqual(r["status"],"identity_mismatch")

    def test_owned_website_evidence_blocks_no_site_inference(self):
        r=parse_bar_profile_contact(SITE_HTML,FIRM,PHONE,"321456")
        self.assertEqual(r["status"],"published_site_and_email")
        self.assertEqual(r["website"],"https://murrayandshepard.com")

    def test_directory_footer_mail_is_not_prospect_email(self):
        r=parse_bar_profile_contact(BAR_HTML.replace(
            "bertha.murray@businessmail.org","support@floridabar.org"
        ),FIRM,PHONE,"321456")
        self.assertEqual(r["email"],"")
        self.assertEqual(r["status"],"no_published_contact")

    def test_contact_evidence_never_promotes_to_strict_lead(self):
        with tempfile.TemporaryDirectory() as d:
            db=SqliteQueue(Path(d)/"store.sqlite")
            lead={"firm":FIRM,"phone":PHONE,"state":"FL","city":"Tampa",
                  "source_url":"https://www.floridalawdirectory.com/firm/murray-shepard-law-llc"}
            self.assertTrue(db.add(lead))
            result=parse_bar_profile_contact(BAR_HTML,FIRM,PHONE,"321456")
            store_bar_contact_proof(db,lead,result,mx_ok=True)
            self.assertEqual(db.counts()["calling_qualified"],0)
            self.assertEqual(db.counts().get("strict_eligible",0),0)
            self.assertEqual(contact_proof_totals(db)["source_emails_with_mx"],1)
            db.close()

if __name__=="__main__":
    unittest.main()
