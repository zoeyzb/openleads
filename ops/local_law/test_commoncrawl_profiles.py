import importlib.util,sqlite3,tempfile,unittest,json
from pathlib import Path
s=importlib.util.spec_from_file_location('ccprofiles',Path(__file__).parent/'commoncrawl_profiles.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class CommonCrawlProfileTests(unittest.TestCase):
 def test_cdx_real_url_and_malformed_rows(self):
  items=[json.dumps({'url':'https://www.lawyer.com/firm/miller-law.html'}),json.dumps({'url':'https://www.lawyer.com/firm/miller-law.html'}),json.dumps({'url':'https://www.lawyer.com/ads/other.html'}),'broken']
  self.assertEqual(m.parse_index_lines(items),['https://www.lawyer.com/firm/miller-law.html'])
 def test_source_size_and_website_exclusion(self):
  page='<h2>Miller & Stone LLP</h2><h2>Miller & Stone LLP</h2><div>Firm Size: 2-5 Attorneys</div><div>Call 312-422-1836</div><a href="https://millerstone.com">Visit Site</a>'
  lead,status=m.extract_profile('https://www.lawyer.com/firm/miller-stone.html',page)
  self.assertEqual(status,'has_owned_website')
  self.assertEqual(lead['phone'],'3124221836')
 def test_only_candidate_not_qualified(self):
  page='<h2>Miller & Stone LLP</h2><h2>Miller & Stone LLP</h2><div>Firm Size: 2-5 Attorneys</div><div>Call 312-422-1836</div>'
  lead,status=m.extract_profile('https://www.lawyer.com/firm/miller-stone.html',page)
  self.assertEqual(status,'candidate_needs_site_audit')
  with tempfile.TemporaryDirectory() as root:
   base=Path(root)
   result=m.run(base/'leads.sqlite',base/'catalog.sqlite',max_fetch=1,seed_urls=[lead['source_url']],fetch=lambda *a,**k:page,delay=0)
   self.assertEqual(result['candidates_added'],1)
   self.assertEqual(result['calling_qualified'],0)
 def test_index_provider_down_does_not_erase_or_fabricate(self):
  from unittest.mock import patch
  with tempfile.TemporaryDirectory() as root:
   base=Path(root)
   with patch.object(m,'index_urls',side_effect=TimeoutError('index unavailable')):
    result=m.run(base/'queue.sqlite',base/'catalog.sqlite',max_fetch=2,delay=0)
   self.assertEqual(result['index']['index_status'],'unavailable')
   self.assertEqual(result['calling_qualified'],0)
   c=sqlite3.connect(base/'catalog.sqlite')
   self.assertEqual(c.execute("select last_error from cc_law_index_cursors where letter='a'").fetchone()[0],'TimeoutError')
   c.close()
 def test_skips_failed_partition_without_blocking_next(self):
  from unittest.mock import patch
  with tempfile.TemporaryDirectory() as root:
   base=Path(root)
   with patch.object(m,'index_urls',side_effect=TimeoutError('index unavailable')):
    m.run(base/'queue.sqlite',base/'catalog.sqlite',max_fetch=1,delay=0)
    result=m.run(base/'queue.sqlite',base/'catalog.sqlite',max_fetch=1,delay=0)
   self.assertEqual(result['index']['partition'],'a')
   self.assertNotEqual(result['index']['crawl'],m.CC_INDEX.rsplit('/',1)[-1])
 def test_same_letter_across_distinct_crawls(self):
  from unittest.mock import patch
  with tempfile.TemporaryDirectory() as root:
   base=Path(root)
   with patch.object(m,'CC_INDEXES',('https://index.commoncrawl.org/AA-index','https://index.commoncrawl.org/BB-index')):
    with patch.object(m,'index_urls',return_value=[]) as find:
     m.run(base/'queue.sqlite',base/'catalog.sqlite',max_fetch=0,delay=0)
     # Mark letters b-z on first crawl done: the next eligible is a on second.
     con=sqlite3.connect(base/'catalog.sqlite')
     for x in 'bcdefghijklmnopqrstuvwxyz':
      con.execute("INSERT INTO cc_law_index_cursors(crawl,letter,attempts,completed_at) VALUES(?,?,1,'done')",('https://index.commoncrawl.org/AA-index',x))
     con.commit();con.close()
     next_run=m.run(base/'queue.sqlite',base/'catalog.sqlite',max_fetch=0,delay=0)
     self.assertEqual(next_run['index']['crawl'],'BB-index')
     self.assertEqual(next_run['index']['partition'],'a')
 def test_exact_firm_size_passes_as_unverified_candidate(self):
  page='<h2>Miller & Stone LLP</h2><h2>Miller & Stone LLP</h2><div>Firm Size: 4</div><div>Call 312-422-1836</div>'
  lead,status=m.extract_profile('https://www.lawyer.com/firm/miller-stone.html',page)
  self.assertEqual(status,'candidate_needs_site_audit')
  self.assertEqual((lead['firm_size_low'],lead['firm_size_high']),(4,4))
 def test_one_attorney_exact_size_is_not_qualified(self):
  page='<h2>Miller & Stone LLP</h2><h2>Miller & Stone LLP</h2><div>Firm Size: 1</div><div>Call 312-422-1836</div>'
  self.assertEqual(m.extract_profile('https://www.lawyer.com/firm/miller-stone.html',page)[1],'outside_firm_size')
 def test_out_of_range_excluded(self):
  page='<h2>Miller & Stone LLP</h2><h2>Miller & Stone LLP</h2>Firm Size: 2-25 Attorneys Call 312-422-1836'
  self.assertEqual(m.extract_profile('https://www.lawyer.com/firm/miller-stone.html',page)[1],'outside_firm_size')
if __name__=='__main__':unittest.main()
