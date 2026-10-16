"""No-headcount-law campaign: independent site checks for local Maps firms.

Missing Maps website metadata is only a research hint. Only two completed
independent website-search checks permit calling eligibility. Fail closed.
"""
from __future__ import annotations
import argparse,json,sqlite3
from datetime import datetime,timezone,timedelta
from pathlib import Path
from urllib.parse import urlparse
from law_local.worker import SqliteQueue,search_for_firm,classify_search_results,utc_now
from law_local.site_provider_health import audit_provider_health

def screen(db_path,limit=10,search=search_for_firm,health_ok=None,research_path=None):
 db=SqliteQueue(db_path)
 db.conn.execute('''CREATE TABLE IF NOT EXISTS maps_website_checks(
     map_id TEXT PRIMARY KEY, checked_at TEXT NOT NULL, status TEXT NOT NULL,
     result_json TEXT NOT NULL)''')
 db.conn.commit()
 # Never clear a candidate with already-confirmed owned-site evidence.
 research=Path(research_path) if research_path is not None else Path(db_path).parent/'research_catalog.sqlite3'
 exclusion=''
 if research.is_file():
  db.conn.execute('ATTACH DATABASE ? AS research',(str(research),))
  # Ambiguous owned-site evidence must also block automatic clearance. It
  # remains research/review evidence, never negative website proof.
  exclusion=" AND NOT EXISTS (SELECT 1 FROM research.external_evidence e WHERE e.lead_id='maps:'||lower(m.map_id) AND e.kind IN ('owned_website','possible_owned_website','owned_website_candidate'))"
 cutoff=(datetime.now(timezone.utc)-timedelta(days=7)).isoformat()
 rows=db.conn.execute('''SELECT m.* FROM maps_raw_candidates m
  LEFT JOIN maps_website_checks w ON m.map_id=w.map_id
  WHERE m.status IN ('unverified_headcount','pending_independent_site_audit')
  AND m.firm GLOB '*[A-Za-z]*'
  AND lower(trim(m.firm)) NOT IN ('attorney','lawyer','law firm','law office','legal services')
  AND COALESCE(w.status,'') NOT IN ('review_website','rejected_inactive','manual_followup_required')
  AND (w.map_id IS NULL OR w.status='inconclusive' OR w.checked_at < ?)
  '''+exclusion+''' ORDER BY m.added_at LIMIT ?''',(cutoff,limit)).fetchall()
 if health_ok is None:
  health_ok=audit_provider_health()['status']=='usable'
 stats={'site_provider_usable':health_ok,'attempted':0,'confirmed_no_site':0,'possible_owned_website':0,
        'provider_degraded':0,'new_calling_qualified':0}
 if not health_ok:
  stats['reason']='independent_site_search_positive_control_failed'
  stats['calling_qualified_total']=db.counts()['calling_qualified']
  db.close()
  return stats
 try:
  for row in rows:
   lead=dict(row)
   stats['attempted']+=1
   sources=search(lead)
   verdict=classify_search_results(sources)
   status=verdict['status']
   if status=='screened_no_site' and not health_ok:
    status='inconclusive'
    verdict={'status':status,'reason':'known_owned_website_positive_control_failed'}
   if status=='screened_no_site':
    stats['confirmed_no_site']+=1
    candidate={'firm':lead['firm'],'phone':lead['phone'],'city':lead['city'],
         'state':lead['state'],'source_url':lead['maps_url']}
    db.add(candidate)
    proof={'status':'call_qualified_no_email','firm':lead['firm'],'phone':lead['phone'],
      'attorneys':None,'email':'','email_source':'',
      'qualification_scope':'law_no_owned_website_any_size',
      'maps_provenance':True,'headcount_source':lead['maps_url'],
      'source_url':lead['maps_url'],'site_status':'screened_no_site',
      'checked_at':utc_now(),
      'site_evidence':{'providers':[{'responded':bool(p.get('responded')),
          'urls':p.get('urls',[])[:10]} for p in sources[:2]]}}
    before=db.counts()['calling_qualified']
    db.record(candidate,proof)
    stats['new_calling_qualified']+=max(0,db.counts()['calling_qualified']-before)
   elif status=='review_website':stats['possible_owned_website']+=1
   else:stats['provider_degraded']+=1
   evidence={'status':status,'verdict':verdict,'providers':[
       {'responded':bool(p.get('responded')),'urls':p.get('urls',[])[:10]}
       for p in sources[:2]]}
   db.conn.execute('''INSERT INTO maps_website_checks VALUES(?,?,?,?)
     ON CONFLICT(map_id) DO UPDATE SET checked_at=excluded.checked_at,
        status=excluded.status,result_json=excluded.result_json''',(
      lead['map_id'],utc_now(),status,json.dumps(evidence)))
   db.conn.commit()
  stats['calling_qualified_total']=db.counts()['calling_qualified']
  return stats
 finally:db.close()
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--db',default=str(Path.home()/'lead-workspace/law-leads.sqlite3'))
 p.add_argument('--max',type=int,default=10);args=p.parse_args()
 print(json.dumps(screen(args.db,args.max)))
