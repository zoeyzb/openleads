"""Only discovered, source-published firm/phone/size may advance to final site/email audit."""
import csv
import tempfile
import unittest
from pathlib import Path

from law_local.maps_first import ingest_maps_candidates,verify_map_headcounts
from law_local.worker import SqliteQueue,evaluate_candidate

HTML="""<html><h1>Riverbank &amp; Grove Law</h1>
<p>Firm Size: 2 - 5 attorneys</p><p>Call (815) 456-1820</p>
<a href="https://riverbankexample.com">Official Website</a>
</html>"""
URL="https://www.lawyer.com/firm/riverbank-and-grove-law.html"
def found(firm,city,state):
    return {"urls":[URL],"responded":1,"queries":1}

class MapsFirstTests(unittest.TestCase):
    def seed(self,folder,phone="8154561820",city="Rockford"):
        file=Path(folder)/"maps.csv"
        with file.open("w",newline="") as fp:
            w=csv.DictWriter(fp,fieldnames=["firm","phone","city","state","maps_source","website_status"])
            w.writeheader()
            w.writerow({"firm":"Riverbank & Grove Law","phone":phone,"city":city,"state":"IL",
                        "maps_source":"https://www.google.com/maps/place/Riverbank-Grove-Law",
                        "website_status":"no_maps_website_field_only"})
            w.writerow({"firm":"Firm Has Site","phone":"8154561830","state":"IL",
                        "maps_source":"https://www.google.com/maps/place/Other",
                        "website_status":"owned_website"})
        return file

    def test_source_discovered_url_passes_to_final_gate_but_not_eligible(self):
        with tempfile.TemporaryDirectory() as d:
            db=SqliteQueue(Path(d)/"db.sqlite")
            self.assertEqual(ingest_maps_candidates(db,self.seed(d)),1)
            stats=verify_map_headcounts(db,fetch_fn=lambda url,timeout=8: HTML,
                  source_resolver=found,seconds=20,max_profiles=5)
            self.assertEqual(stats["actual_directory_links"],1)
            self.assertEqual(stats["identity_phone_size_matches"],1)
            self.assertEqual(stats["added_to_final_audit"],1)
            self.assertEqual(db.counts()["pending"],1)
            self.assertEqual(db.counts()["calling_qualified"],0)
            record=evaluate_candidate(
                {"firm":"Riverbank & Grove Law","phone":"8154561820","source_url":URL},
                HTML,[{"responded":True,"urls":[]},{"responded":True,"urls":[]}],
                lambda domain:True)
            self.assertEqual(record["status"],"review_website")
            self.assertEqual(ingest_maps_candidates(db,self.seed(d)),0)
            db.close()

    def test_phone_or_firm_mismatch_never_advances(self):
        with tempfile.TemporaryDirectory() as d:
            db=SqliteQueue(Path(d)/"db.sqlite")
            ingest_maps_candidates(db,self.seed(d,phone="8154561831"))
            stats=verify_map_headcounts(db,fetch_fn=lambda url,timeout=8: HTML,
                  source_resolver=found,seconds=20,max_profiles=5)
            self.assertEqual(stats["added_to_final_audit"],0)
            self.assertEqual(db.counts()["calling_qualified"],0)
            db.close()

    def test_provider_outage_retries_later_and_does_not_assume_no_site(self):
        with tempfile.TemporaryDirectory() as d:
            db=SqliteQueue(Path(d)/"db.sqlite")
            ingest_maps_candidates(db,self.seed(d))
            stats=verify_map_headcounts(db,fetch_fn=lambda url,timeout=8: HTML,
                  source_resolver=lambda *args:{"responded":0,"urls":[]},seconds=20)
            self.assertEqual(stats["added_to_final_audit"],0)
            self.assertEqual(db.conn.execute(
                "SELECT status FROM maps_raw_candidates LIMIT 1").fetchone()[0],"unverified_headcount")
            db.close()
