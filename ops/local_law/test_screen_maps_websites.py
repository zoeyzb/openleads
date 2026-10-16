import csv,tempfile,unittest
from pathlib import Path
from law_local.worker import SqliteQueue
from law_local.maps_first import ingest_maps_candidates
from ops.local_law.screen_maps_websites import screen
MAP='https://www.google.com/maps/place/Example-Firm'
GOOD=[{'responded':True,'urls':[]},{'responded':True,'urls':[]}]
class MapSiteScreeningTests(unittest.TestCase):
 def seed(self,directory):
  path=Path(directory)/'map.csv'
  with path.open('w',newline='') as output:
   w=csv.DictWriter(output,fieldnames=['firm','phone','city','state','maps_source','website_status'])
   w.writeheader();w.writerow(dict(firm='Example Law Group',phone='3124221836',city='Chicago',state='IL',maps_source=MAP,website_status='no_maps_website_field_only'))
  dbpath=Path(directory)/'leads.sqlite3'
  queue=SqliteQueue(dbpath);ingest_maps_candidates(queue,path);queue.close()
  return dbpath
 def test_provider_health_failure_never_qualifies_blank_maps_website(self):
  with tempfile.TemporaryDirectory() as directory:
   db=self.seed(directory)
   result=screen(db,5,search=lambda *_:GOOD,health_ok=False)
   self.assertEqual(result['new_calling_qualified'],0)
   self.assertEqual(result['attempted'],0)
   self.assertEqual(result['reason'],'independent_site_search_positive_control_failed')
   queue=SqliteQueue(db);self.assertEqual(queue.counts()['calling_qualified'],0);queue.close()
 def test_two_provider_controlled_clearance_produces_source_attributed_call_record(self):
  with tempfile.TemporaryDirectory() as directory:
   db=self.seed(directory)
   result=screen(db,5,search=lambda *_:GOOD,health_ok=True)
   self.assertEqual(result['new_calling_qualified'],1)
   self.assertEqual(result['calling_qualified_total'],1)
   queue=SqliteQueue(db)
   exported=Path(directory)/'call.csv'
   self.assertEqual(queue.export('calling_qualified',exported),1)
   self.assertEqual(screen(db,5,search=lambda *_:GOOD,health_ok=True)['attempted'],0)
   queue.close()
 def test_existing_candidate_gets_completed_evidence(self):
  with tempfile.TemporaryDirectory() as directory:
   db=self.seed(directory)
   queue=SqliteQueue(db)
   queue.add(dict(firm='Example Law Group',phone='3124221836',city='Chicago',state='IL',source_url=MAP))
   queue.close()
   self.assertEqual(screen(db,5,search=lambda *_:GOOD,health_ok=True)['new_calling_qualified'],1)
 def test_old_owned_and_inactive_reviews_are_not_automatically_cleared(self):
  for status in ('review_website','rejected_inactive'):
   with tempfile.TemporaryDirectory() as directory:
    db=self.seed(directory)
    screen(db,1,search=lambda *_:GOOD,health_ok=False)
    queue=SqliteQueue(db)
    mid=queue.conn.execute('SELECT map_id FROM maps_raw_candidates').fetchone()[0]
    queue.conn.execute('INSERT INTO maps_website_checks VALUES(?,?,?,?)',(mid,'2000-01-01T00:00:00Z',status,'{}'))
    queue.conn.commit();queue.close()
    self.assertEqual(screen(db,1,search=lambda *_:GOOD,health_ok=True)['attempted'],0)
 def test_detected_site_is_excluded_even_with_healthy_providers(self):
  with tempfile.TemporaryDirectory() as directory:
   db=self.seed(directory)
   found=[{'responded':True,'urls':['https://examplelawgroup.com']},{'responded':True,'urls':[]}]
   result=screen(db,5,search=lambda *_:found,health_ok=True)
   self.assertEqual(result['possible_owned_website'],1)
   self.assertEqual(result['calling_qualified_total'],0)
if __name__=='__main__':unittest.main()
