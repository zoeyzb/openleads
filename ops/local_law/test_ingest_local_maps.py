import csv,io,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from ops.local_law.ingest_local_maps import ingest
class FakeResponse:
 def __init__(self,body):self.body=body
 def __enter__(self):return self
 def __exit__(self,*a):return False
 def read(self,*a):return self.body
class IngestSelfHostedMapsTests(unittest.TestCase):
 def test_active_job_cannot_claim_qualified_leads(self):
  with tempfile.TemporaryDirectory() as folder:
   with patch('ops.local_law.ingest_local_maps.urllib.request.urlopen',return_value=FakeResponse(b'{"Status":"working"}')):
    result=ingest('f38d9f47-61cc-42fb-b039-a7750fce8b30',folder)
   self.assertFalse(result['ingested'])
 def test_completed_job_only_creates_maps_candidates(self):
  raw=io.StringIO();w=csv.DictWriter(raw,fieldnames=['title','phone','website','category','link','address']);w.writeheader()
  w.writerow({'title':'Potter & Finch Law Group','phone':'4693452873','website':'','category':'Law firm','link':'https://www.google.com/maps/place/Potter-Finch-Law','address':'123 Main St, Waco, TX 76701'})
  w.writerow({'title':'Owned Firm','phone':'4693452874','website':'https://owned.example','category':'Law firm','link':'https://www.google.com/maps/place/Owned','address':'123 Main St, Waco, TX 76701'})
  def fetch(url,timeout):return FakeResponse(b'{"Status":"ok"}' if not url.endswith('/download') else raw.getvalue().encode())
  with tempfile.TemporaryDirectory() as folder:
   with patch('ops.local_law.ingest_local_maps.urllib.request.urlopen',side_effect=fetch):
    a=ingest('f38d9f47-61cc-42fb-b039-a7750fce8b30',folder)
    b=ingest('f38d9f47-61cc-42fb-b039-a7750fce8b30',folder)
   self.assertEqual(a['raw_listings'],2)
   self.assertEqual(a['new_unverified_queue_rows'],1)
   self.assertEqual(b['new_unverified_queue_rows'],0)
   self.assertEqual(a['qualified_calling_leads_created'],0)
if __name__=='__main__':unittest.main()
