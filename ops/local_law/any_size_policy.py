"""One-time, evidence-preserving migration for the explicit any-size policy."""
import json,sqlite3
from pathlib import Path
from law_local.worker import SqliteQueue,utc_now
POLICY="law-any-size-email-20261019"

def restore_operator_reviews(q):
 """Recover fresh completed reviews stranded by a superseded size policy.

 No new qualification inference: validate the original signed-off evidence,
 retain its dates, and refuse adverse evidence across shared-phone aliases.
 """
 from ops.local_law.import_site_reviews import validate,fresh
 restored=0
 rows=q.conn.execute("SELECT * FROM candidates WHERE status IN ('pending','review_firmwide_headcount','review_headcount_scope')").fetchall()
 for row in rows:
  try:
   prior=json.loads(row['result_json']);review=prior.get('operator_review',{})
   if (prior.get('qualification_hold')!='prior_any_size_policy_not_current_qualification'
       or prior.get('review_method')!='operator_two_provider_review'):
    continue
   lead=validate(review)
   active=review.get('active_practice_evidence',{})
   if (q._id(lead)!=row['id'] or not fresh(active.get('checked_at'))
       or active.get('url')!=lead['source_url'] or not active.get('note')):
    continue
   blocked=False
   for alias in q.conn.execute('SELECT status,result_json FROM candidates WHERE phone=?',(row['phone'],)):
    e=json.loads(alias['result_json'])
    if (e.get('eligibility_hold') or e.get('owned_site_url') or e.get('website_candidates')
        or alias['status'] in ('rejected_inactive','review_inactive','review_website','review_nonlaw_employer')
        or e.get('site_status') in ('review_website','published_owned_website')):
     blocked=True;break
   if blocked or any(h['disposition'] in ('owned','uncertain')
                     for provider in review['providers'] for h in provider['results']):
    continue
   result={**prior,'status':'call_qualified_no_email',
           'checked_at':review['checked_at'],'qualification_scope':'law_no_owned_website_any_size',
           'site_status':'screened_no_site','email':'','email_source':''}
   result.pop('qualification_hold',None)
   if not q._verified_for_export(row,result,result['status']):continue
   q.record(lead,result);restored+=1
  except (ValueError,TypeError,KeyError,AttributeError):continue
 return restored

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
  restored=restore_operator_reviews(q)
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
 return {"requeued_for_fresh_checks":count,"directory_size_holds_requeued":cc,"qualified_created":0,"operator_reviews_restored":restored}
if __name__=='__main__':print(json.dumps(apply(Path.home()/"lead-workspace")))
