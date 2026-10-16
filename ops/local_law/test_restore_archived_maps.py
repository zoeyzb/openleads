import csv,tempfile,unittest
from pathlib import Path
from ops.local_law.restore_archived_maps import restore
class RestoreMapsTests(unittest.TestCase):
 def test_reimport_keeps_only_unverified_deduped_source_records(self):
  with tempfile.TemporaryDirectory() as dir:
   root=Path(dir);source=root/"historical.csv";db=root/"leads.sqlite3"
   with source.open("w",newline="") as f:
    w=csv.DictWriter(f,fieldnames=["firm","phone","state","city","maps_source","website_status"]);w.writeheader()
    w.writerow({"firm":"Example Firm LLP","phone":"3124221836","state":"IL","city":"Chicago","maps_source":"https://www.google.com/maps/place/example","website_status":"no_maps_website_field_only"})
   a=restore(db,source);b=restore(db,source)
   self.assertEqual(a["archived_maps_new_unverified"],1)
   self.assertEqual(b["archived_maps_new_unverified"],0)
   self.assertEqual(b["qualified_created"],0)
if __name__=="__main__":unittest.main()
