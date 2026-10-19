"""One-time, evidence-preserving migration for the explicit any-size policy."""
import json,sqlite3
from pathlib import Path
from law_local.worker import SqliteQueue,utc_now
POLICY="law-any-size-email-20261019"

def apply(root):
 root=Path(root);q=SqliteQueue(root/"law-leads.sqlite3")
 q.conn.execute("CREATE TABLE IF NOT EXISTS qualification_policy_history(candidate_id TEXT,policy TEXT,prior_status TEXT,prior_result_json TEXT,changed_at TEXT,PRIMARY KEY(candidate_id,policy))")
 q.conn.execute("CREATE TABLE IF NOT EXISTS qualification_policy_migrations(policy TEXT PRIMARY KEY,applied_at TEXT,requeued INTEGER)")
 count=0
 try:
  if not q.conn.execute("SELECT 1 FROM qualification_policy_migrations WHERE policy=?",(POLICY,)).fetchone():
   for row in q.conn.execute("SELECT * FROM candidates WHERE status IN ('review_firmwide_headcount','review_headcount_scope','unverified_size')").fetchall():
    try:e=json.loads(row["result_json"] or "{}")
    except (ValueError,TypeError):continue
    if (e.get("eligibility_hold") or e.get("owned_site_url") or e.get("website_candidates") or
        e.get("site_status") in ('review_website','published_owned_website') or
        e.get("site_evidence",{}).get("status")=="review_website"):continue
    q.conn.execute("INSERT INTO qualification_policy_history VALUES(?,?,?,?,?)",(row["id"],POLICY,row["status"],row["result_json"],utc_now()))
    q.conn.execute("UPDATE candidates SET status='pending',attempts=0,updated=? WHERE id=?",(utc_now(),row["id"]))
    count+=1
   q.conn.execute("INSERT INTO qualification_policy_migrations VALUES(?,?,?)",(POLICY,utc_now(),count));q.conn.commit()
 finally:q.close()
 cc=0;catalog=root/"research_catalog.sqlite3"
 if catalog.exists():
  with sqlite3.connect(catalog,timeout=20) as con:
   con.execute("CREATE TABLE IF NOT EXISTS cc_any_size_history(url TEXT PRIMARY KEY,prior_status TEXT,changed_at TEXT)")
   tables={r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
   if 'cc_law_profile_urls' in tables:
    rows=con.execute("SELECT url,status FROM cc_law_profile_urls WHERE status IN ('outside_firm_size','no_explicit_size') AND url NOT IN (SELECT url FROM cc_any_size_history)").fetchall()
    for url,status in rows:
     con.execute("INSERT INTO cc_any_size_history VALUES(?,?,?)",(url,status,utc_now()))
     con.execute("UPDATE cc_law_profile_urls SET status='pending' WHERE url=?",(url,));cc+=1
 return {"requeued_for_fresh_checks":count,"directory_size_holds_requeued":cc,"qualified_created":0}
if __name__=='__main__':print(json.dumps(apply(Path.home()/"lead-workspace")))
