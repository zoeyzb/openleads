import json,sqlite3,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from ops.local_law import local_maps_controller as m
class LocalControllerTests(unittest.TestCase):
 def test_submits_bounded_job_then_does_not_duplicate(self):
  with tempfile.TemporaryDirectory() as td:
   calls=[]
   def fetch(url,request=None):
    calls.append((url,request))
    if request:return {'id':'12345678-1234-1234-1234-123456789abc'}
    return {'Status':'working'}
   one=m.run_once(td,fetch=fetch,free_bytes=12*1024**3)
   two=m.run_once(td,fetch=fetch,free_bytes=12*1024**3)
   self.assertEqual(one['action'],'submitted')
   self.assertEqual(two['action'],'in_progress')
   self.assertEqual(len([r for _,r in calls if r]),1)
   self.assertEqual(one['qualified_created'],0)
 def test_fails_closed_on_low_disk(self):
  with tempfile.TemporaryDirectory() as td:
   result=m.run_once(td,fetch=lambda *a,**k: self.fail('called'),free_bytes=5*1024**3)
   self.assertEqual(result['action'],'paused_low_disk')
 def test_completes_and_records_real_metrics(self):
  with tempfile.TemporaryDirectory() as td:
   seq=iter([{'id':'12345678-1234-1234-1234-123456789abc'},{'Status':'ok'}])
   fetch=lambda *a,**k:next(seq)
   m.run_once(td,fetch=fetch,free_bytes=12*1024**3)
   outcome={'ingested':True,'raw_listings':25,'maps_no_site_phone_candidates':3,'new_unverified_queue_rows':3,'qualified_calling_leads_created':0}
   with patch.object(m,'ingest',return_value=outcome):
    result=m.run_once(td,fetch=fetch,free_bytes=12*1024**3)
   self.assertEqual(result['action'],'imported')
   self.assertEqual(result['maps_no_site_phone_candidates'],3)
   db=sqlite3.connect(Path(td)/'research_catalog.sqlite3')
   self.assertEqual(db.execute('select count(*) from local_maps_jobs where status="completed"').fetchone()[0],1)
 def test_bad_provider_does_not_consume_market(self):
  with tempfile.TemporaryDirectory() as td:
   bad=m.run_once(td,fetch=lambda *a,**k: (_ for _ in ()).throw(OSError('unavailable')),free_bytes=12*1024**3)
   self.assertEqual(bad['action'],'submit_failed')
   with sqlite3.connect(Path(td)/'research_catalog.sqlite3') as db:
    self.assertEqual(db.execute('select count(*) from local_maps_jobs where status="working"').fetchone()[0],0)
if __name__=='__main__':unittest.main()
