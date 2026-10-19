import json,sqlite3,tempfile,unittest
from pathlib import Path
from law_local.catalog_email import recover
from law_local.worker import utc_now
from ops.local_law.test_plea_source import PAGE,parse_directory,group_contacts
class CatalogEmailTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.catalog=Path(self.tmp.name)/"research_catalog.sqlite3"
  self.lead={"firm":"Dover & Associates LLP","phone":"3026789900","state":"DE","source_url":"https://www.lawyer.com/firm/fixture.html"}
  self.providers=[{"provider":"one","responded":True,"urls":[]},{"provider":"two","responded":True,"urls":[]}]
  self.result={"firm":self.lead["firm"],"phone":self.lead["phone"],"attorneys":4,
       "status":"call_qualified_no_email","qualification_scope":"law_no_owned_website_2_10_phone",
       "headcount_source":self.lead["source_url"],"site_status":"screened_no_site",
       "checked_at":utc_now(),"site_evidence":{"providers":self.providers}}
  with sqlite3.connect(self.catalog) as con:
   con.execute("CREATE TABLE plea_firm_research(firm TEXT,phone TEXT,research_json TEXT)")
   record=group_contacts(parse_directory(PAGE,"de"))[0]
   con.execute("INSERT INTO plea_firm_research VALUES(?,?,?)",(record["firm"],record["phone"],json.dumps(record)))
 def tearDown(self):self.tmp.cleanup()
 def call(self,lead=None,result=None,page=PAGE,providers=None):
  return recover(lead or self.lead,result or self.result,self.catalog,
           lambda *a,**k:page,lambda d:True,lambda l:providers or self.providers,probe=lambda emails:[])
 def test_exact_public_contact_promotes_with_separate_provenance(self):
  result=self.call()
  self.assertEqual(result["status"],"strict_eligible")
  self.assertEqual(result["email"],"janice@examplefirm.com")
  self.assertTrue(result["email_mx_ok"])
  self.assertNotEqual(result["email_source"],result["headcount_source"])
  self.assertTrue(result["email_evidence"]["block_sha256"])
 def test_shared_phone_different_firm_or_footer_email_is_not_accepted(self):
  self.assertEqual(self.call(lead={**self.lead,"firm":"Other Practice"})["status"],"call_qualified_no_email")
  self.assertEqual(self.call(page="<footer>info@plea.net</footer>")["status"],"call_qualified_no_email")
 def test_new_positive_owned_domain_revokes_prior_negative(self):
  providers=[{**self.providers[0],"urls":["https://practice-owned.example/"]},self.providers[1]]
  self.assertEqual(self.call(providers=providers)["status"],"review_website")
 def test_catalog_email_accepts_solo_firm(self):
  self.assertEqual(self.call(result={**self.result,"attorneys":1})["status"],"strict_eligible")
