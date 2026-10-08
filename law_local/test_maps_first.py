"""Maps-first source linking regression; no-website field never means verified."""
import csv
import tempfile
import unittest
from pathlib import Path

from law_local.maps_first import profile_urls,ingest_maps_candidates,verify_map_headcounts
from law_local.worker import SqliteQueue

HTML="""<html><h1>Riverbank & Grove Law</h1><p>Firm Size: 2 - 5 attorneys</p>
<p>Call (815) 456-1820</p><p>Published public firm directory profile.</p></html>"""
URL="https://www.lawyer.com/firm/riverbank-and-grove-law.html"

class MapsFirstTests(unittest.TestCase):
    def test_only_existing_maps_records_and_no_website_proof_inflation(self):
        with tempfile.TemporaryDirectory() as d:
            file=Path(d)/"maps.csv"
            with file.open("w",newline="") as fp:
                w=csv.DictWriter(fp,fieldnames=["firm","phone","state","maps_source","website_status"])
                w.writeheader()
                w.writerow({"firm":"Riverbank & Grove Law","phone":"(815) 456-1820","state":"IL",
                            "maps_source":"https://www.google.com/maps/place/Riverbank-Grove-Law",
                            "website_status":"no_maps_website_field_only"})
                w.writerow({"firm":"Website Firm LLC","phone":"(815) 456-1830","state":"IL",
                            "maps_source":"https://www.google.com/maps/place/Website-Firm",
                            "website_status":"owned_website"})
            db=SqliteQueue(Path(d)/"db.sqlite")
            self.assertEqual(ingest_maps_candidates(db,file),1)
            self.assertEqual(db.counts()["calling_qualified"],0)
            urls=profile_urls("Riverbank & Grove Law","IL")
            self.assertIn(URL,urls)
            def fetch(url,timeout=8):
                return HTML if url==URL else "<html>no match</html>"+" -"*80
            stats=verify_map_headcounts(db,fetch_fn=fetch,seconds=15,max_profiles=10)
            self.assertEqual(stats["identity_phone_size_matches"],1)
            self.assertEqual(stats["added_to_final_audit"],1)
            self.assertEqual(db.counts()["pending"],1)
            self.assertEqual(db.counts()["calling_qualified"],0)
            self.assertEqual(ingest_maps_candidates(db,file),0)
            self.assertEqual(verify_map_headcounts(db,fetch_fn=fetch)["maps_checked"],0)
            db.close()

    def test_phone_or_firm_mismatch_never_promoted(self):
        with tempfile.TemporaryDirectory() as d:
            file=Path(d)/"maps.csv"
            with file.open("w",newline="") as fp:
                w=csv.DictWriter(fp,fieldnames=["firm","phone","state","website_status"])
                w.writeheader()
                w.writerow({"firm":"Riverbank & Grove Law","phone":"8154561830","state":"IL",
                            "website_status":"no_maps_website_field_only"})
            db=SqliteQueue(Path(d)/"db.sqlite")
            ingest_maps_candidates(db,file)
            stats=verify_map_headcounts(db,fetch_fn=lambda url,timeout=8:HTML,seconds=15,max_profiles=10)
            self.assertEqual(stats["new_qualified_candidates"],0)
            self.assertEqual(db.counts()["calling_qualified"],0)
            db.close()


    def test_location_aware_firm_size_directory_source(self):
        urls=profile_urls("Riverbank & Grove Law","IL","Rockford")
        page="https://findthelawfirms.com/law-firms/illinois/rockford/riverbank-and-grove-law/"
        self.assertIn(page,urls)
        html="""<html><h1>Riverbank &amp; Grove Law</h1>
        <p>Firm Size: 2-5 Attorneys</p>
        <p>815-456-1820</p><a href="https://ownedexample.test">Official Website</a>
        </html>"""
        with tempfile.TemporaryDirectory() as d:
            file=Path(d)/"maps.csv"
            with file.open("w",newline="") as fp:
                w=csv.DictWriter(fp,fieldnames=["firm","phone","city","state","maps_source","website_status"])
                w.writeheader()
                w.writerow({"firm":"Riverbank & Grove Law","phone":"8154561820",
                            "city":"Rockford","state":"IL",
                            "maps_source":"https://www.google.com/maps/place/Riverbank-Grove-Law",
                            "website_status":"no_maps_website_field_only"})
            db=SqliteQueue(Path(d)/"db.sqlite")
            ingest_maps_candidates(db,file)
            def fetch(url,timeout=8):
                return html if url==page else ("<html>no match</html>"+"word "*50)
            stats=verify_map_headcounts(db,fetch_fn=fetch,seconds=25,max_profiles=10)
            self.assertEqual(stats["identity_phone_size_matches"],1)
            self.assertEqual(stats["added_to_final_audit"],1)
            self.assertEqual(db.counts()["calling_qualified"],0)
            # Identifying a likely owned website must block promotion; an absent
            # Maps field alone does not overrule source-published website links.
            from law_local.worker import evaluate_candidate
            result=evaluate_candidate(
                {"firm":"Riverbank & Grove Law","phone":"8154561820","source_url":page},
                html,[{"responded":True,"urls":[]},{"responded":True,"urls":[]}],
                lambda domain:True)
            self.assertEqual(result["status"],"review_website")
            db.close()

if __name__=="__main__":
    unittest.main()
