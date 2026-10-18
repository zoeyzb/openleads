"""Recovery must preserve partial scraper results without fabricating eligibility."""
import csv
import json
import tempfile
import unittest
from pathlib import Path
from law_local.maps_extract import extract,maps_candidate,state_from_address,city_from_address

GOOD={
    "title":"Potter & Finch Law Group",
    "phone":"(469) 345-2873",
    "website":"",
    "category":"Law firm",
    "link":"https://www.google.com/maps/place/Potter-Finch-Law",
    "address":"123 Main St, Waco, TX 76701",
}
class MapsExtractTests(unittest.TestCase):
    def test_candidate_is_never_verified_from_missing_website_field(self):
        candidate,reason=maps_candidate(GOOD)
        self.assertEqual(reason,"candidate")
        self.assertEqual(candidate["state"],"TX")
        self.assertEqual(candidate["phone"],"4693452873")
        self.assertEqual(candidate["website_status"],"no_maps_website_field_only")
        self.assertEqual(candidate["email_status"],"unverified")
        self.assertEqual(candidate["headcount_status"],"unverified")

    def test_no_private_law_firm_no_maps_provenance_or_published_site(self):
        for patch in (
            {"website":"https://example.com"},
            {"title":"County Prosecutor Office"},
            {"link":"https://random.example/place/123"},
            {"phone":"2025550144"},
        ):
            item=dict(GOOD,**patch)
            candidate,why=maps_candidate(item)
            self.assertIsNone(candidate,reason:=why)

    def test_csv_partial_results_dedupe_and_status(self):
        with tempfile.TemporaryDirectory() as folder:
            raw=Path(folder)/"results.csv"
            out=Path(folder)/"phone-candidates.csv"
            summary=Path(folder)/"summary.json"
            with raw.open("w",newline="",encoding="utf-8") as fd:
                wr=csv.DictWriter(fd,fieldnames=list(GOOD))
                wr.writeheader()
                wr.writerow(GOOD)
                wr.writerow(GOOD)
                wr.writerow(dict(GOOD,website="https://owned.com",title="Own Site Law"))
            result=extract(raw,out,summary)
            self.assertEqual(result["raw_rows"],3)
            self.assertEqual(result["maps_no_site_phone_candidates"],1)
            self.assertEqual(result["strict_eligible_verified"],0)
            with out.open(newline="") as fd:
                rows=list(csv.DictReader(fd))
            self.assertEqual(len(rows),1)
            self.assertEqual(rows[0]["headcount_status"],"unverified")
            self.assertEqual(json.loads(summary.read_text())["maps_no_site_phone_candidates"],1)

    def test_no_raw_file_not_fake_records(self):
        with tempfile.TemporaryDirectory() as folder:
            out=Path(folder)/"out.csv"
            data=extract(Path(folder)/"absent.csv",out)
            self.assertEqual(data["maps_no_site_phone_candidates"],0)
            self.assertTrue(out.exists())

    def test_full_state_names(self):
        self.assertEqual(state_from_address("Altoona, Pennsylvania, USA"),"PA")
        self.assertEqual(state_from_address("123 Main St, Waco, TX 76701, United States"),"TX")
        self.assertEqual(city_from_address("123 Main St, Waco, TX 76701, United States"),"Waco")
