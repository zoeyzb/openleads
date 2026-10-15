#!/usr/bin/env python3
"""Publish only anonymous law-pipeline aggregates to an unlisted GitHub Gist."""
import json, sqlite3, subprocess, os, time, tempfile
from pathlib import Path
from datetime import datetime, timezone
ROOT=Path.home()/"lead-workspace"
CONFIG=ROOT/"metrics-feed-config.json"
def rows(db,sql):
 try:
  con=sqlite3.connect(f"file:{db}?mode=ro",uri=True,timeout=6)
  value=con.execute(sql).fetchall();con.close()
  return value
 except (sqlite3.Error, OSError):
  return []
def count(db,table,where=""):
 val=rows(db,f"SELECT COUNT(*) FROM {table} {where}")
 return int(val[0][0]) if val else 0
def snapshot():
 db=ROOT/"law-leads.sqlite3"
 raw=rows(db,"SELECT status,COUNT(*) FROM candidates GROUP BY status")
 statuses={str(k):int(v) for k,v in raw}
 # 0 or count from current phone-qualified export; excludes raw statuses not evidence-verified
 qualified=0
 try:
  import sys;sys.path.insert(0,str(ROOT/"openleads"))
  from law_local.worker import SqliteQueue
  q=SqliteQueue(db);qualified=int(q.counts().get("calling_qualified",0));q.close()
 except Exception: pass
 states=rows(ROOT/"coverage.sqlite3","SELECT state,last_attempt,last_success,last_error,attempts FROM areas WHERE city='' AND source='directory' ORDER BY state")
 coverage=[{"state":r[0],"attempts":int(r[4] or 0),"lastAttempt":r[1],"lastSuccess":r[2],"stateStatus":"low-yield" if r[3] else ("checked" if r[4] else "not-started")} for r in states]
 triage=rows(ROOT/"research_catalog.sqlite3","SELECT status, COUNT(*) FROM source_triage GROUP BY status")
 provider="unknown"
 logfile=ROOT/"final-provider-health.log"
 if logfile.exists():
  try: provider=json.loads(logfile.read_text().splitlines()[-1])["website_search_provider_health"]["status"]
  except (ValueError,KeyError,IndexError):pass
 catalog=count(ROOT/"research_catalog.sqlite3","source_research")
 sources=rows(ROOT/"research_catalog.sqlite3","SELECT source,COUNT(*) FROM source_research GROUP BY source ORDER BY source")
 return {"schema":1,"updatedAt":datetime.now(timezone.utc).isoformat(timespec="seconds"),"host":"Mac local worker","research":catalog,"sourceBreakdown":{str(k):int(v) for k,v in sources},"callingQualified":qualified,"candidateStatuses":statuses,"triageStatuses":{k:v for k,v in triage},"coverage":coverage,"providerHealth":provider,"source":"mac-sqlite-aggregate","note":"Research rows are not verified leads. Email is optional for phone-qualified leads."}
def api(args,body=None):
 command=["/opt/homebrew/bin/gh","api",*args]
 r=subprocess.run(command,input=json.dumps(body) if body else None,text=True,capture_output=True,timeout=25)
 if r.returncode:raise RuntimeError("GitHub Gist request failed: "+r.stderr[-350:])
 return json.loads(r.stdout)
def publish():
 data=snapshot()
 content=json.dumps(data,separators=(",",":"),ensure_ascii=True)
 if CONFIG.exists():config=json.loads(CONFIG.read_text())
 else:config={}
 gist=config.get("gist_id")
 if gist:
  res=api(["--method","PATCH",f"/gists/{gist}","--input","-"],{"files":{"law-pipeline-metrics.json":{"content":content}}})
 else:
  res=api(["--method","POST","/gists","--input","-"],{"description":"OpenLeads public aggregate operations metrics (no lead data)","public":False,"files":{"law-pipeline-metrics.json":{"content":content}}})
  gist=res["id"]
  CONFIG.write_text(json.dumps({"gist_id":gist,"raw_url":res["files"]["law-pipeline-metrics.json"]["raw_url"]},indent=2))
  os.chmod(CONFIG,0o600)
 print(json.dumps({"gist_id":gist,"metrics":data,"gist_url":res.get("html_url"),"updated":True}))
 return data
if __name__=="__main__":publish()
