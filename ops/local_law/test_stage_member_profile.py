import sqlite3, tempfile, unittest
from pathlib import Path
from ops.local_law.stage_member_profile import stage

HTML='''<div class="memberDirectoryDetailsContainer"><div class="memberDirectoryDetailsHeaderContainer"><h2>Rebecca Rodriguez</h2><h3>Sauk Valley Law Group, LLC</h3></div><h4>Member profile details</h4><div class="fieldLabel"><span>Email</span></div><div class="fieldBody"><a href="mailto:rodriguez@saukvalleylaw.com">rodriguez@saukvalleylaw.com</a></div><div class="fieldLabel"><span>Phone</span></div><div class="fieldBody">815-535-6769</div></div><div class="gadgetContentEditableArea">info@irela.org</div>'''
SOURCE='https://www.irela.org/Sys/PublicProfile/63300247'

class MemberResearchTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
  c=sqlite3.connect(self.root/'law-leads.sqlite3')
  c.execute('CREATE TABLE maps_raw_candidates(map_id TEXT PRIMARY KEY,firm TEXT,phone TEXT)')
  c.execute('INSERT INTO maps_raw_candidates VALUES(?,?,?)',
            ('sauk valley law group llc|8155356769','Sauk Valley Law Group, LLC','8155356769'))
  c.commit();c.close()
 def tearDown(self):self.tmp.cleanup()
 def stage_fixture(self,**kwargs):
  return stage('sauk valley law group llc|8155356769',SOURCE,root=self.root,
               fetch=kwargs.get('fetch',lambda url,timeout=12:HTML),
               mx=kwargs.get('mx',lambda _:True))
 def test_scoped_source_stages_evidence_once_without_qualifying(self):
  first=self.stage_fixture()
  self.assertEqual(first['status'],'email_phone_sourced_needs_firmwide_size_and_site_audit')
  self.assertEqual(first['email_staged'],1)
  self.assertEqual(first['new_strict_qualified'],0)
  again=self.stage_fixture()
  self.assertEqual(again['email_staged'],0)
  c=sqlite3.connect(self.root/'research_catalog.sqlite3')
  self.assertEqual(c.execute('SELECT COUNT(*) FROM external_evidence').fetchone()[0],1)
  c.close()
 def test_footer_email_not_used_as_practice_email(self):
  html=HTML.replace('mailto:rodriguez@saukvalleylaw.com','mailto:other@invalid.test').replace('>rodriguez@saukvalleylaw.com','>other@invalid.test')
  data=self.stage_fixture(fetch=lambda url,timeout=12:html,mx=lambda _:False)
  self.assertEqual(data['email_staged'],0)
 def test_missing_matching_phone_never_stages(self):
  data=self.stage_fixture(fetch=lambda url,timeout=12:HTML.replace('815-535-6769','815-535-6768'))
  self.assertEqual(data['status'],'profile_email_phone_mismatch')
 def test_untrusted_site_never_stages(self):
  def unexpected_fetch(*args,**kwargs):
   raise AssertionError('untrusted site must be rejected before network access')
  data=stage('sauk valley law group llc|8155356769', 'https://other.example/profile',root=self.root,fetch=unexpected_fetch)
  self.assertEqual(data['status'],'unsupported_public_profile_source')
 def test_wrong_firm_never_stages(self):
  data=self.stage_fixture(fetch=lambda url,timeout=12:HTML.replace('Sauk Valley Law Group, LLC','Other Law Group LLC'))
  self.assertEqual(data['status'],'profile_identity_mismatch')

if __name__=='__main__':unittest.main()
