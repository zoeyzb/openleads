"""Safely import historic Maps research CSVs into the current Mac SQLite queue."""
import argparse,json
from pathlib import Path
from law_local.worker import SqliteQueue
from law_local.maps_first import ingest_maps_candidates
def restore(db_path,csv_path):
 db=SqliteQueue(db_path)
 try:
  added=ingest_maps_candidates(db,csv_path)
  return {"archived_maps_new_unverified":added,"qualified_created":0}
 finally:db.close()
if __name__=="__main__":
 p=argparse.ArgumentParser();p.add_argument("--csv",required=True);p.add_argument("--db",default=str(Path.home()/"lead-workspace/law-leads.sqlite3"));a=p.parse_args()
 print(json.dumps(restore(a.db,a.csv)))
