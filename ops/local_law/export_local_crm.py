"""Export a small PRIVATE browser queue from the existing local SQLite database.

For loopback preview only. Never commit or deploy the output JSON.
"""
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
ROOT=Path.home()/"lead-workspace"
DB=ROOT/"law-leads.sqlite3"
OUT=Path(__file__).resolve().parents[2]/"site/law-dashboard/local-queue.json"
def main():
    with sqlite3.connect(f"file:{DB}?mode=ro",uri=True) as db:
        db.row_factory=sqlite3.Row
        rows=db.execute("""SELECT id,firm,phone,city,state,source_url,status,attempts,result_json,updated
           FROM candidates ORDER BY CASE status WHEN 'call_qualified_no_email' THEN 0 WHEN 'strict_eligible' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,updated DESC LIMIT 250""").fetchall()
        items=[]
        for r in rows:
            proof={}
            try: proof=json.loads(r["result_json"] or "{}")
            except ValueError: pass
            items.append({k:r[k] for k in ("id","firm","phone","city","state","source_url","status","attempts","updated")}|{"evidence":proof if isinstance(proof,dict) else {}})
    OUT.write_text(json.dumps({"updatedAt":datetime.now(timezone.utc).isoformat(),"entries":items},separators=(",",":")))
    OUT.chmod(0o600)
    print(f"Local-only queue snapshot: {len(items)} records")
if __name__=="__main__":main()
