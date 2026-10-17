import csv,importlib.util,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location("sheet_sync",str(Path(__file__).parent/"sync_sheet.py"))
sync=importlib.util.module_from_spec(spec);spec.loader.exec_module(sync)
class SyncProofTests(unittest.TestCase):
 def test_phone_only_row_is_call_ready(self):
  with tempfile.TemporaryDirectory() as d:
   with patch.object(sync,"ROOT",Path(d)),patch("law_local.worker.SqliteQueue") as queue:
    p=Path(d)/"call-qualified-law.csv"
    fields=["Firm","Phone","City","State","Attorneys","Email","Headcount source","Email source","Website audit","Checked at"]
    with p.open("w",newline="") as f:
     w=csv.DictWriter(f,fieldnames=fields);w.writeheader()
     row={"Firm":"Fixture & Partners","Phone":"3124221836","City":"Chicago","State":"IL",
      "Attorneys":"","Email":"","Headcount source":"",
      "Email source":"","Website audit":"screened_no_site","Checked at":"2026-10-13"}
     w.writerow(row)
     w.writerow({**row,"Firm":"Unverified Source","Website audit":"inconclusive"})
    got=list(sync.rows())
    self.assertEqual(len(got),1)
    self.assertFalse(got[0]["Email"])
    self.assertEqual(len(sync.key(got[0])),24)
    queue.assert_called_once_with(Path(d)/"law-leads.sqlite3")
    queue.return_value.export.assert_called_once_with("calling_qualified",p)
    queue.return_value.close.assert_called_once_with()
if __name__=="__main__":unittest.main()
