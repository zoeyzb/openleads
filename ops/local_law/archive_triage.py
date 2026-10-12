"""Classify restored research sources without inventing firm-wide size or site absence."""
import argparse,json,sqlite3,time
from pathlib import Path
from urllib.parse import urlparse
from law_local import worker
DB=Path.home()/"lead-workspace/research_catalog.sqlite3"
def run(limit=30):
 c=sqlite3.connect(DB,timeout=15)
 c.execute("""CREATE TABLE IF NOT EXISTS source_triage (lead_id TEXT PRIMARY KEY, status TEXT, website_url TEXT, source_checked_at TEXT, error TEXT)""")
 c.commit()
 rows=c.execute("""SELECT lead_id,firm,phone,city,state,source_url FROM source_research WHERE source='FL roster' AND lead_id NOT IN (SELECT lead_id FROM source_triage) LIMIT ?""",(limit,)).fetchall()
 counts={}
 for lead_id,firm,phone,city,state,url in rows:
  status="source_unavailable"; website=""; error=""
  try:
   html=worker.fetch_public(url,timeout=8)
   lead=dict(firm=firm,phone=phone,city=city,state=state,source_url=url)
   if not worker.firm_identity_matches(html,lead): status="identity_or_phone_unmatched"
   else:
    source=worker.evaluate_published_source(html,lead)
    if source["website_candidates"]:
     status="owned_site_hint";website=";".join(source["website_candidates"][:3])
    else:status="needs_independent_firmwide_size_and_site"
  except Exception as exc:error=type(exc).__name__+":"+str(exc)[:100]
  c.execute("INSERT OR REPLACE INTO source_triage VALUES (?,?,?,?,?)",(lead_id,status,website,worker.utc_now(),error));c.commit()
  counts[status]=counts.get(status,0)+1
  time.sleep(.4)
 print(json.dumps({"attempted":len(rows),"results":counts,"call_qualified":0}))
if __name__=="__main__":
 p=argparse.ArgumentParser();p.add_argument("--max",type=int,default=20);a=p.parse_args();run(a.max)
