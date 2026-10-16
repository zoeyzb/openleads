"""Bounded one-way promotion of *research candidates* into the existing SQLite verifier.

No Redis, extra database, bulk duplication, or relaxation of qualifying evidence.
"""
from __future__ import annotations
import argparse
import json
import sqlite3
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from law_local.worker import SqliteQueue, normalize_phone
from law_local.florida_roster import clearly_non_law_employer, ambiguous_employer_identity, NON_PRIVATE
import re

ROOT=Path.home()/"lead-workspace"
def bridge(catalog,queue,limit=20):
    active=queue.conn.execute("SELECT count(*) FROM candidates WHERE status='pending'").fetchone()[0]
    if active>=100:
        return dict(scanned=0,added_unverified=0,skipped=0,qualified=0,reason="pending_queue_cap_100")
    limit=min(limit,100-active)
    con=sqlite3.connect(f"file:{Path(catalog).resolve()}?mode=ro",uri=True)
    selected=con.execute("""
        SELECT r.firm,r.phone,r.city,r.state,r.source_url,r.reported_attorneys
        FROM source_research r
        LEFT JOIN source_triage t ON t.lead_id=r.lead_id
        WHERE r.proof_status='needs_firmwide_size_and_owned_site'
          AND (t.status IS NULL OR t.status IN ('needs_independent_firmwide_size_and_site','needs_independent_site_audit'))
          AND length(r.phone)>=10
        ORDER BY CASE WHEN t.status='needs_independent_firmwide_size_and_site' THEN 0 ELSE 1 END,
                 r.lead_id LIMIT ?
    """,(max(1,limit*6),)).fetchall()
    inserted=0;checked=0;skipped=0
    # Prioritize identifiable private-law practices; generic in-house employer
    # and placeholder records should not monopolize the 100-row verifier queue.
    obvious_nonfirm=re.compile(r"(?i)^(?:attorney|lawyer|counsel|law firm|legal services)$")
    for firm,phone,city,state,url,_ in selected:
        if inserted>=limit:break
        checked+=1
        if (clearly_non_law_employer(firm) or NON_PRIVATE.search(firm)
                or ambiguous_employer_identity(firm) or obvious_nonfirm.fullmatch(firm.strip())
                or not normalize_phone(phone)):
            skipped+=1;continue
        if queue.add(dict(firm=firm,phone=phone,city=city,state=state,source_url=url)):
            inserted+=1
    con.close()
    return dict(scanned=checked,added_unverified=inserted,skipped=skipped,qualified=0)
def main():
    p=argparse.ArgumentParser()
    p.add_argument("--catalog",default=str(ROOT/"research_catalog.sqlite3"))
    p.add_argument("--db",default=str(ROOT/"law-leads.sqlite3"))
    p.add_argument("--max",type=int,default=20)
    a=p.parse_args()
    q=SqliteQueue(a.db)
    try:print(json.dumps(bridge(a.catalog,q,a.max)))
    finally:q.close()
if __name__=="__main__":main()
