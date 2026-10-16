"""Self-hosted, bounded law-firm Maps discovery with resumable yield metrics.

Only source-candidates move to Maps research; never to qualified calling lists.
No Redis, paid APIs, proxies, unrestricted cycles or external service exposure.
"""
from __future__ import annotations
import json, shutil, sqlite3, time, urllib.request
from pathlib import Path
from ops.local_law.ingest_local_maps import HOST, ingest

MARKETS=(
 ('Galesburg','IL'),('Burlington','IA'),('Cedar Falls','IA'),
 ('Ottumwa','IA'),('Keokuk','IA'),('Quincy','IL'),
 ('Macomb','IL'),('Muscatine','IA'),('Fort Madison','IA'),
 ('Kewanee','IL'),('Monmouth','IL'),('Pella','IA'),
 ('Dixon','IL'),('Sterling','IL'),('Clinton','IA'),
 ('Marshalltown','IA'),('Pekin','IL'),('Freeport','IL'),
 ('Altoona','PA'),('Johnstown','PA'),('Chambersburg','PA'),
 ('Lima','OH'),('Findlay','OH'),('Mansfield','OH'),
 ('Marion','IN'),('Richmond','IN'),('Anderson','IN'),
 ('Danville','VA'),('Staunton','VA'),('Winchester','VA'),
 ('Decatur','AL'),('Florence','AL'),('Gadsden','AL'),
 ('Hattiesburg','MS'),('Meridian','MS'),('Columbus','MS'),
 ('Texarkana','TX'),('Paris','TX'),('Sherman','TX'),
 ('Dothan','AL'),('Opelika','AL'),('New Bern','NC'),
)


def initialize(db):
 db.executescript('''CREATE TABLE IF NOT EXISTS local_maps_jobs(
 job_id TEXT PRIMARY KEY, market TEXT NOT NULL, state TEXT NOT NULL,
 submitted_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'working',
 raw_count INTEGER NOT NULL DEFAULT 0,
 candidate_count INTEGER NOT NULL DEFAULT 0,
 imported_count INTEGER NOT NULL DEFAULT 0,
 last_checked TEXT NOT NULL DEFAULT '');
 CREATE INDEX IF NOT EXISTS idx_local_maps_market ON local_maps_jobs(market,state);''')
 db.commit()

def get_json(url,request=None):
 req=request or urllib.request.Request(url,headers={'accept':'application/json'})
 with urllib.request.urlopen(req,timeout=12) as response:return json.load(response)

def run_once(root=None,fetch=get_json,free_bytes=None,clock=None):
 root=Path(root or Path.home()/'lead-workspace')
 db=sqlite3.connect(root/'research_catalog.sqlite3',timeout=15)
 initialize(db)
 clock=clock or time.time
 now=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime(clock()))
 try:
  # Seed historical manual pilots, so the same cities are not rescanned.
  manual=root/'local-maps-pilot-job.json'
  if manual.is_file():
   try:
    jobid=json.loads(manual.read_text())['id']
    db.execute('''INSERT OR IGNORE INTO local_maps_jobs(job_id,market,state,submitted_at,status)
       VALUES(?,?,?,?,?)''',(jobid,'manual-pilot','',now,'historical'))
    db.commit()
   except (ValueError,KeyError,TypeError):pass
  active=db.execute("SELECT job_id,market,state,submitted_at FROM local_maps_jobs WHERE status='working' ORDER BY submitted_at LIMIT 1").fetchone()
  if active:
   job_id,market,state,submitted=active
   try:
    job=fetch(f'{HOST}/api/v1/jobs/{job_id}')
   except Exception as exc:
    return {'action':'blocked_provider','job_id':job_id,'reason':type(exc).__name__}
   status=str(job.get('Status','')).lower()
   if status in ('ok','done','completed','success','finished'):
    try:result=ingest(job_id,root=root)
    except Exception as exc:
     return {'action':'import_failed','job_id':job_id,'reason':type(exc).__name__}
    db.execute('''UPDATE local_maps_jobs SET status='completed',raw_count=?,candidate_count=?,imported_count=?,last_checked=? WHERE job_id=?''',(
     result['raw_listings'],result['maps_no_site_phone_candidates'],result['new_unverified_queue_rows'],now,job_id))
    db.commit()
    return {'action':'imported','market':market,'state':state,**result}
   if status in ('failed','cancelled','canceled','error'):
    db.execute("UPDATE local_maps_jobs SET status=?,last_checked=? WHERE job_id=?",(status,now,job_id));db.commit()
    return {'action':'job_failed','job_id':job_id,'status':status}
   return {'action':'in_progress','job_id':job_id,'status':status}
  free=free_bytes if free_bytes is not None else shutil.disk_usage(root).free
  if free < 6*1024**3:
   return {'action':'paused_low_disk','free_gb':round(free/1024**3,2)}
  # One new locality per completed interval; don't reissue a market because
  # it had 0 blank-site prospects. An exhausted list pauses, not loops.
  previous={(row[0],row[1]) for row in db.execute("SELECT market,state FROM local_maps_jobs")}
  choice=next(((city,state) for city,state in MARKETS if (city,state) not in previous),None)
  if choice is None:return {'action':'market_list_exhausted'}
  city,state=choice
  payload={'name':f'OpenLeads law {city} {state}',
           'keywords':[f'law firm in {city} {state}',f'attorneys in {city} {state}'],
           'depth':1,'max_time':150,'extra_reviews':False,'lang':'en'}
  request=urllib.request.Request(f'{HOST}/api/v1/jobs',method='POST',data=json.dumps(payload).encode(),headers={'content-type':'application/json'})
  try:
   job=fetch(f'{HOST}/api/v1/jobs',request=request)
   jobid=job['id']
   if not isinstance(jobid,str) or len(jobid)!=36:raise ValueError('invalid_job_id')
  except Exception as exc:
   return {'action':'submit_failed','market':city,'state':state,'reason':type(exc).__name__}
  db.execute('INSERT INTO local_maps_jobs(job_id,market,state,submitted_at) VALUES(?,?,?,?)',(jobid,city,state,now))
  db.commit()
  return {'action':'submitted','job_id':jobid,'market':city,'state':state,'qualified_created':0}
 finally:db.close()

if __name__=='__main__':
 print(json.dumps(run_once()))
