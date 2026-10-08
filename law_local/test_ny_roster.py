"""NY official open-data source grouping is never full law firm headcount proof."""
import tempfile
import json
import unittest
from pathlib import Path
from law_local.ny_roster import query_url,parse_groups,evidence_class,collect,export
from law_local.worker import SqliteQueue
from urllib.parse import urlparse,parse_qs

SAMPLE=[
 {"company_name":"AARONSON RAPPAPORT FEINSTEIN & DEUTSCH","phone_number":"(212) 593-6700","city":"NEW YORK","state":"NY","ny_attorneys":"3"},
 {"company_name":"AAREAL CAPITAL CORPORATION","phone_number":"(212) 508-4080","city":"NEW YORK","state":"NY","ny_attorneys":"2"},
 {"company_name":"350 JAY STREET","phone_number":"(718) 250-2001","city":"BROOKLYN","state":"NY","ny_attorneys":"2"},
 {"company_name":"AARON RICHARD GOLUB, ESQUIRE, P.C.","phone_number":"(212) 838-4811","city":"NEW YORK","state":"NY","ny_attorneys":"2"},
]
class NYSourceTests(unittest.TestCase):
    def test_query_stays_in_current_status_and_bounds_size(self):
        qs=parse_qs(urlparse(query_url(100,200)).query)
        self.assertIn("status='Currently registered'",qs["$where"][0])
        self.assertEqual(qs["$having"][0],"count(*) between 2 and 10")
        self.assertEqual(qs["$offset"][0],"200")
    def test_company_and_address_not_silently_called_law_firms(self):
        self.assertEqual(evidence_class("AAREAL CAPITAL CORPORATION"),"not_law_business")
        self.assertEqual(evidence_class("350 JAY STREET"),"not_law_business")
        self.assertEqual(evidence_class("AARONSON RAPPAPORT FEINSTEIN & DEUTSCH"),"possible_private_law_firm")
        self.assertEqual(evidence_class("AARON RICHARD GOLUB, ESQUIRE, P.C."),"possible_private_law_firm")
        groups=parse_groups(SAMPLE)
        self.assertEqual(len(groups),4)
        self.assertEqual(sum(v["status"]=="possible_private_law_firm" for v in groups),2)
    def test_checkpointed_ny_groups_never_become_eligible_without_full_checks(self):
        with tempfile.TemporaryDirectory() as folder:
            db=SqliteQueue(Path(folder)/"state.sqlite")
            result=collect(db,fetch_fn=lambda url,timeout=15:json.dumps(SAMPLE),
                           max_pages=1,page_size=4,seconds=10)
            self.assertEqual(result["total_groups"],4)
            self.assertEqual(result["possible_private_firm_groups"],2)
            self.assertEqual(db.counts()["calling_qualified"],0)
            path=Path(folder)/"source.csv"
            self.assertEqual(export(db,path),4)
            self.assertEqual(collect(db,fetch_fn=lambda url,timeout=15:"failure",
                           max_pages=1,page_size=4)["pages_skipped"],1)
            self.assertIn("NOT VERIFIED",path.read_text())
            db.close()
