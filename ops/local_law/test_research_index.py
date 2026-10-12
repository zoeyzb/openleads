import importlib.util,sqlite3,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
SPEC=importlib.util.spec_from_file_location("research_index",str(Path(__file__).parent/"research_index.py"))
research_index=importlib.util.module_from_spec(SPEC);SPEC.loader.exec_module(research_index)
class CatalogTests(unittest.TestCase):
 def test_archived_sources_dedupe_without_qualification(self):
  with tempfile.TemporaryDirectory() as folder:
   base=Path(folder);fl=base/"fl.sqlite3";ny=base/"ny.sqlite3";out=base/"catalog.sqlite3"
   a=sqlite3.connect(fl)
   a.execute("CREATE TABLE candidates(firm TEXT,phone TEXT,city TEXT,state TEXT,source_url TEXT,status TEXT)")
   a.execute("CREATE TABLE fl_roster_frontier(url TEXT,listed_attorneys INTEGER,status TEXT)")
   for i in range(2):
    url=f"https://www.floridalawdirectory.com/firm/sample-{i}"
    a.execute("INSERT INTO candidates VALUES(?,?,?,?,?,?)",("Sample Law Group","7277259411","","FL",url,"pending"))
    a.execute("INSERT INTO fl_roster_frontier VALUES(?,?,'size_phone_source_only')",(url,4))
   a.commit();a.close()
   b=sqlite3.connect(ny)
   b.execute("CREATE TABLE ny_registration_groups(company TEXT,phone TEXT,city TEXT,state TEXT,source_url TEXT,ny_attorneys INTEGER,status TEXT)")
   b.execute("INSERT INTO ny_registration_groups VALUES(?,?,?,?,?,?,'possible_private_law_firm')",
        ("Other Counsel LLP","2123334444","New York","NY","https://data.ny.gov/example",3))
   b.commit();b.close()
   with patch.object(research_index,"FL",fl),patch.object(research_index,"NY",ny),patch.object(research_index,"INDEX",out):
    result=research_index.ingest()
   self.assertEqual(result["source_rows"],3)
   self.assertEqual(result["unique_research_contacts"],2)
   self.assertEqual(result["duplicate_identity_rows"],1)
   self.assertEqual(result["qualified"],0)
   conn=sqlite3.connect(out)
   self.assertEqual(conn.execute("SELECT COUNT(*) FROM source_research WHERE proof_status LIKE 'needs_%'").fetchone()[0],2)
   conn.close()
if __name__=="__main__":unittest.main()
