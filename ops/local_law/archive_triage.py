"""Classify restored research sources without inventing firm-wide size or site absence."""
import argparse,json,sqlite3,time,sys
from pathlib import Path
from urllib.parse import urlparse
sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from law_local import worker
DB=Path.home()/"lead-workspace/research_catalog.sqlite3"
def run(limit=30):
 c=sqlite3.connect(DB,timeout=15)
 c.execute("""CREATE TABLE IF NOT EXISTS source_triage (lead_id TEXT PRIMARY KEY, status TEXT, website_url TEXT, source_checked_at TEXT, error TEXT)""")
 c.execute("""CREATE TABLE IF NOT EXISTS source_bonus_emails (
  lead_id TEXT NOT NULL,email TEXT NOT NULL,source_url TEXT NOT NULL, checked_at TEXT NOT NULL,
  PRIMARY KEY(lead_id,email))""")
 c.commit()
 # Research-only triage. Prioritize state-reported 2-10 and a valid-looking
 # business phone to reduce wasted requests; NEVER treat that count as firmwide.
 c.execute("CREATE INDEX IF NOT EXISTS idx_triage_status ON source_triage(status)")
 rows=c.execute("""SELECT r.lead_id,r.firm,r.phone,r.city,r.state,r.source_url
 FROM source_research r
 WHERE r.source IN ('FL roster','NY registrations')
   AND length(r.phone)>=10
   AND NOT EXISTS (SELECT 1 FROM source_triage t WHERE t.lead_id=r.lead_id)
 ORDER BY CASE WHEN r.source='FL roster' THEN 0 ELSE 1 END, r.lead_id
 LIMIT ?""",(limit,)).fetchall()
 counts={}
 for lead_id,firm,phone,city,state,url in rows:
  status="source_unavailable"; website=""; error=""
  try:
   html=worker.fetch_public(url,timeout=8)
   lead=dict(firm=firm,phone=phone,city=city,state=state,source_url=url)
   if not worker.firm_identity_matches(html,lead): status="identity_or_phone_unmatched"
   else:
    source=worker.evaluate_published_source(html,lead)
    # Bonus-only: never let absent email block source triage or calling qualification.
    for email in source["emails"]:
     c.execute("INSERT OR IGNORE INTO source_bonus_emails VALUES(?,?,?,?)",
               (lead_id,email,url,worker.utc_now()))
    if source["website_candidates"]:
     status="owned_site_hint";website=";".join(source["website_candidates"][:3])
    else:status="needs_independent_site_audit"
  except Exception as exc:error=type(exc).__name__+":"+str(exc)[:100]
  c.execute("INSERT OR REPLACE INTO source_triage VALUES (?,?,?,?,?)",(lead_id,status,website,worker.utc_now(),error));c.commit()
  counts[status]=counts.get(status,0)+1
  time.sleep(.4)
 print(json.dumps({"attempted":len(rows),"results":counts,"call_qualified":0}))
if __name__=="__main__":
 p=argparse.ArgumentParser();p.add_argument("--max",type=int,default=20);a=p.parse_args();run(a.max)
