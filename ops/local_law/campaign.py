#!/usr/bin/env python3
"""Local campaign controller; uses existing OpenLeads source adapters, no paid host."""
import csv, json, os, sqlite3, subprocess, sys, time
from pathlib import Path
from datetime import datetime, timezone, timedelta
ROOT=Path.home()/"lead-workspace"
SRC=ROOT/"openleads"
DB=ROOT/"law-leads.sqlite3"
OUT=ROOT/"strict-qualified-law.csv"
PY="/opt/homebrew/bin/python3.11"
STATES=["TX","GA","NC","PA","OH","MI","IL","CA"]
def now(): return datetime.now(timezone.utc).isoformat(timespec="seconds")
def connect():
 c=sqlite3.connect(ROOT/"coverage.sqlite3",timeout=20)
 c.execute("PRAGMA journal_mode=WAL")
 c.execute("""CREATE TABLE IF NOT EXISTS areas (state TEXT, city TEXT NOT NULL DEFAULT '', source TEXT, last_attempt TEXT, last_success TEXT, next_retry TEXT, attempts INTEGER DEFAULT 0, last_exit INTEGER, last_error TEXT DEFAULT '', PRIMARY KEY(state,city,source))""")
 c.commit()
 return c
def command(args,seconds=180):
 return subprocess.run([PY,*args],cwd=SRC,text=True,capture_output=True,timeout=seconds)
def strict_export():
 from_path=DB
 c=sqlite3.connect(from_path)
 c.row_factory=sqlite3.Row
 try: rows=c.execute("SELECT firm,phone,city,state,source_url,result_json FROM candidates WHERE status='strict_eligible'").fetchall()
 except sqlite3.OperationalError: rows=[]
 qualified=[]
 for row in rows:
  try:
   ev=json.loads(row["result_json"])
   email=str(ev.get("email","")).strip()
   sys.path.insert(0,str(SRC))
   from law_local.worker import SqliteQueue
   if (not SqliteQueue._verified_for_export(row,ev,"strict_eligible")
       or not email
       or "@" not in email or not ev.get("email_source") or not ev.get("headcount_source")
       or not ev.get("checked_at") or not row["phone"]):
    continue
   checked=datetime.fromisoformat(ev["checked_at"].replace("Z","+00:00"))
   if checked.tzinfo is None or not timedelta(0)<=datetime.now(timezone.utc)-checked<=timedelta(days=30):continue
   qualified.append(dict(firm=row["firm"],phone=row["phone"],city=row["city"],state=row["state"],
     attorneys=ev["attorneys"],email=email,headcount_source=ev["headcount_source"],
     email_source=ev["email_source"],site_status=ev["site_status"],checked_at=ev["checked_at"]))
  except (ValueError,TypeError,KeyError,AttributeError): continue
 cols=["firm","phone","city","state","attorneys","email","headcount_source","email_source","site_status","checked_at"]
 temp=OUT.with_suffix(".tmp")
 with temp.open("w",newline="") as f:
  writer=csv.DictWriter(f,fieldnames=cols);writer.writeheader();writer.writerows(qualified)
 os.replace(temp,OUT)
 c.close()
 print(json.dumps(dict(event="strict_export",qualified=len(qualified),file=str(OUT))))
 return len(qualified)
def calling_export():
 from pathlib import Path
 from sys import path as sys_path
 import csv
 sys_path.insert(0,str(SRC))
 from law_local.worker import SqliteQueue
 queue=SqliteQueue(DB)
 try:
  result=queue.export("calling_qualified",ROOT/"call-qualified-law.csv")
 finally:
  queue.close()
 print(json.dumps({"event":"calling_export","phone_qualified":result,"file":str(ROOT/"call-qualified-law.csv")}))
 return result

def discovery_result(exit_code,output):
    if exit_code!=0:
        return "failed"
    for line in reversed(output.splitlines()):
        try: payload=json.loads(line)
        except (ValueError,TypeError):continue
        d=payload.get("discovery")
        if isinstance(d,dict):
            if int(d.get("candidates_added",0))==0:
                return "zero_source_yield"
            return "candidates_added"
        r=payload.get("fl_roster_profiles")
        if isinstance(r,dict):
            return "candidates_added" if int(r.get("added",0))>0 else "zero_source_yield"
    return "no_machine_readable_yield"

def cycle():
 import fcntl
 ROOT.mkdir(exist_ok=True)
 with (ROOT/"campaign.lock").open("w") as lock:
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError: print('another run is active');return 2
  # Research the recovered 9,037-source pool incrementally before wasting discovery queries.
  archive_script=SRC/"ops/local_law/archive_triage.py"
  if archive_script.exists():
   try:
    triage=command(["ops/local_law/archive_triage.py","--max","25"],100)
    (ROOT/"campaign-runs.log").open("a").write(json.dumps(dict(time=now(),archive_triage_exit=triage.returncode,output=(triage.stdout+triage.stderr)[-1200:]))+"\n")
   except subprocess.TimeoutExpired:
    (ROOT/"campaign-runs.log").open("a").write(json.dumps(dict(time=now(),archive_triage_error="timeout"))+"\n")
  cov=connect()
  rows=cov.execute("SELECT state FROM areas WHERE source='directory' AND (next_retry IS NULL OR next_retry <= ?) ORDER BY coalesce(last_attempt,'') LIMIT 1",(now(),)).fetchall()
  if not rows:
   for st in STATES: cov.execute("INSERT OR IGNORE INTO areas(state,source) VALUES(?,'directory')",(st,))
   cov.commit()
   rows=cov.execute("SELECT state FROM areas WHERE source='directory' AND (next_retry IS NULL OR next_retry <= ?) ORDER BY coalesce(last_attempt,'') LIMIT 1",(now(),)).fetchall()
  if not rows:
   print("no area due; calling and strict exports only");calling_export();strict_export();return 0
  st=rows[0][0]
  started=now()
  args=(["-m","law_local.florida_roster","--db",str(DB),"--max-pages","3","--max-profiles","50","--seconds","90"] if st=="FL" else ["law_local/worker.py","--db",str(DB),"discover","--states",st,"--max-queries","5","--max-pages","25","--seconds","100","--delay","2"])
  error=""
  try:
   r=command(args,130);rc=r.returncode
   log=(r.stdout+"\n"+r.stderr)[-8000:]
   error=log[-1200:] if rc else ""
   outcome=discovery_result(rc,log)
   if outcome!="candidates_added":
    error=outcome
  except subprocess.TimeoutExpired:rc=124;log="deadline exceeded";error=log
  (ROOT/"campaign-runs.log").open("a").write(json.dumps(dict(time=started,state=st,exit=rc,output=log))+"\n")
  success=bool(rc==0 and error=="")
  retry=(datetime.now(timezone.utc)+timedelta(days=7 if error=="zero_source_yield" else 1)).isoformat(timespec="seconds")
  cov.execute("UPDATE areas SET last_attempt=?,last_success=CASE WHEN ? THEN ? ELSE last_success END,next_retry=?,attempts=attempts+1,last_exit=?,last_error=? WHERE state=? AND city='' AND source='directory'",(started,int(success),now(),retry,rc,error,st))
  # Observed city records are candidate hints, not evidence of completed city coverage.
  for city,state in sqlite3.connect(DB).execute("SELECT DISTINCT city,state FROM candidates WHERE state=? AND trim(city)!=''",(st,)):
   cov.execute("INSERT OR IGNORE INTO areas(state,city,source,last_attempt) VALUES(?,?,'candidate_observed',?)",(state,city,now()))
  cov.commit()
  # Never spend verifier requests while the known-owned-site positive control fails.
  try:
   health=command(["-m","law_local.site_provider_health","--ready-flag",str(ROOT/"site-ready.flag")],45)
   try:
    site_state=json.loads((health.stdout.strip().splitlines() or ["{}"])[-1]).get("website_search_provider_health",{}).get("status")
   except (ValueError,IndexError):
    site_state="unavailable"
  except subprocess.TimeoutExpired:
   health=None
   site_state="timeout"
  if health is None or health.returncode!=0 or site_state!="usable":
   verify_exit=3
   verify_output="blocked_website_provider: known-owned-site control failed; no candidate requests spent"
  else:
   pending=command(["law_local/worker.py","--db",str(DB),"run","--max","20","--workers","2","--seconds","90"],120)
   verify_exit=pending.returncode
   verify_output=(pending.stdout+pending.stderr)[-5000:]
  (ROOT/"campaign-runs.log").open("a").write(json.dumps(dict(time=now(),verify_exit=verify_exit,site_status=site_state,output=verify_output))+"\n")
  phone_count=calling_export()
  count=strict_export()
  if os.environ.get("LAW_SHEETS_CREDENTIALS"):
   sync=subprocess.run([str(ROOT/".venv/bin/python"),str(ROOT/"sync_sheet.py")],capture_output=True,text=True,timeout=120)
   (ROOT/"campaign-runs.log").open("a").write(json.dumps(dict(time=now(),sync_exit=sync.returncode,output=(sync.stdout+sync.stderr)[-1500:]))+"\n")
  print(json.dumps(dict(state=st,discovery_exit=rc,verification_exit=verify_exit,calling_qualified=phone_count,strict_qualified=count)))
  # Provider outages are expected controlled blocks, not scheduler crashes.
  # Keep the true verification_exit=3 and failed discovery in the run log.
  return 0 if rc==0 and verify_exit in (0,3) else 1
if __name__=="__main__":
 if len(sys.argv)>1 and sys.argv[1]=="export": calling_export();strict_export()
 elif len(sys.argv)>1 and sys.argv[1]=="coverage":
  con=connect();print(json.dumps([dict(zip(["state","city","source","last_attempt","last_success","next_retry","attempts","last_exit","last_error"],r)) for r in con.execute("SELECT * FROM areas ORDER BY state")]))
 else:sys.exit(cycle())
