#!/usr/bin/env python3
"""Publish only anonymous law-pipeline aggregates to an unlisted GitHub Gist."""
import json, sqlite3, subprocess, os, time, tempfile
from pathlib import Path
from datetime import datetime, timezone
ROOT=Path.home()/"lead-workspace"
CONFIG=ROOT/"metrics-feed-config.json"
HISTORY=ROOT/"metrics-history.json"
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
 qualified=0; strict_qualified=0
 try:
  import sys;sys.path.insert(0,str(ROOT/"openleads"))
  from law_local.worker import SqliteQueue
  q=SqliteQueue(db)
  try:
   qualified=int(q.counts().get("calling_qualified",0))
   # Count only rows that pass the SAME full source and freshness gates as
   # the strict export, including the source-verified email and 2-10 lawyers.
   strict_qualified=sum(1 for _ in q._verified_rows(("strict_eligible",)))
  finally:q.close()
 except Exception: pass
 states=rows(ROOT/"coverage.sqlite3","SELECT state,last_attempt,last_success,last_error,attempts FROM areas WHERE city='' AND source='directory' ORDER BY state")
 coverage=[{"state":r[0],"attempts":int(r[4] or 0),"lastAttempt":r[1],"lastSuccess":r[2],"stateStatus":"low-yield" if r[3] else ("checked" if r[4] else "not-started")} for r in states]
 triage=rows(ROOT/"research_catalog.sqlite3","SELECT status, COUNT(*) FROM source_triage GROUP BY status")
 # Read bounded run log and expose aggregate-only diagnostics, never firm names or phone numbers.
 last_verification={}
 logpath=ROOT/"campaign-runs.log"
 if logpath.exists():
  try:
   for line in logpath.read_text().splitlines()[-30:]:
    record=json.loads(line)
    if "verify_exit" in record:
     last_verification={"time":record.get("time"),"exit":record.get("verify_exit"),"siteHealth":record.get("site_status","unknown")}
  except (ValueError,OSError):pass
 provider="unknown"
 logfile=ROOT/"final-provider-health.log"
 if logfile.exists():
  try: provider=json.loads(logfile.read_text().splitlines()[-1])["website_search_provider_health"]["status"]
  except (ValueError,KeyError,IndexError):pass
 # The continuously running campaign is more recent than the last manual
 # provider-health probe. Only let a recent diagnostic supersede a stale one.
 if last_verification and last_verification.get("siteHealth") in ("usable","degraded"):
  try:
   checked=datetime.fromisoformat(last_verification["time"].replace("Z","+00:00"))
   if checked.tzinfo and 0<=(datetime.now(timezone.utc)-checked).total_seconds()<7200:
    provider=last_verification["siteHealth"]
  except (ValueError,TypeError,KeyError):pass
 catalog=count(ROOT/"research_catalog.sqlite3","source_research")
 sources=rows(ROOT/"research_catalog.sqlite3","SELECT source,COUNT(*) FROM source_research GROUP BY source ORDER BY source")
 return {"schema":1,"updatedAt":datetime.now(timezone.utc).isoformat(timespec="seconds"),"host":"Mac local worker","research":catalog,"sourceBreakdown":{str(k):int(v) for k,v in sources},"callingQualified":qualified,"strictQualified":strict_qualified,
         "legacyPhoneOnly":max(0,qualified-strict_qualified),"candidateStatuses":statuses,"triageStatuses":{k:v for k,v in triage},"coverage":coverage,"providerHealth":provider,"lastVerification":last_verification,"source":"mac-sqlite-aggregate","note":"Strict eligible requires source-confirmed 2–10 attorneys, no attributable owned website, matching business phone and a usable published email. Legacy phone-only is not strict."}
def api(args,body=None):
 command=["/opt/homebrew/bin/gh","api",*args]
 r=subprocess.run(command,input=json.dumps(body) if body else None,text=True,capture_output=True,timeout=25)
 if r.returncode:raise RuntimeError("GitHub Gist request failed: "+r.stderr[-350:])
 return json.loads(r.stdout)
def publish():
 # Rebuild private local CRM snapshot on the SAME publisher schedule.
 # A failure here must not risk exposing contacts through public Gist data.
 import sys
 sys.path.insert(0,str(ROOT/"openleads"))
 from ops.local_law.export_local_crm import main as export_private_crm
 export_private_crm()
 data=snapshot()
 # Persist one aggregate sample per UTC hour; do not manufacture earlier history.
 try:
  history=json.loads(HISTORY.read_text()) if HISTORY.exists() else []
 except (ValueError,OSError):
  history=[]
 stamp=data["updatedAt"][:13]
 item={"hour":stamp,"qualified":data["strictQualified"],"research":data["research"],
       "triaged":sum(data["triageStatuses"].values()),"candidates":sum(data["candidateStatuses"].values())}
 history=[v for v in history if isinstance(v,dict) and v.get("hour")!=stamp]
 history.append(item)
 history=sorted(history,key=lambda x:x["hour"])[-168:]
 temp=HISTORY.with_suffix(".tmp");temp.write_text(json.dumps(history));os.replace(temp,HISTORY)
 data["history"]=history
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
