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
STATES=["TX","GA","NC","PA","OH","MI","IL","CA","FL","NY"]
def now(): return datetime.now(timezone.utc).isoformat(timespec="seconds")
def log_record(record):
 with (ROOT/"campaign-runs.log").open("a") as log:
  log.write(json.dumps(record)+"\n")

def scheduled_cycle():
 started=time.monotonic()
 log_record(dict(time=now(),event="cycle_started",pid=os.getpid()))
 try:
  code=cycle()
 except Exception as exc:
  log_record(dict(time=now(),event="cycle_crashed",error=type(exc).__name__,
                  duration_seconds=round(time.monotonic()-started,2)))
  raise
 log_record(dict(time=now(),event="cycle_finished",exit=code,
                 duration_seconds=round(time.monotonic()-started,2)))
 return code

def connect():
 c=sqlite3.connect(ROOT/"coverage.sqlite3",timeout=20)
 c.execute("PRAGMA journal_mode=WAL")
 c.execute("""CREATE TABLE IF NOT EXISTS areas (state TEXT, city TEXT NOT NULL DEFAULT '', source TEXT, last_attempt TEXT, last_success TEXT, next_retry TEXT, attempts INTEGER DEFAULT 0, last_exit INTEGER, last_error TEXT DEFAULT '', PRIMARY KEY(state,city,source))""")
 # Reset only old ZERO-yield coverage once when switching provider method.
 # Without this, the repaired adapter stays idle behind seven-day legacy holds.
 c.execute("CREATE TABLE IF NOT EXISTS coverage_method_migrations(method TEXT PRIMARY KEY,applied_at TEXT NOT NULL,reset_areas INTEGER NOT NULL)")
 method="selfhosted-directory-v1"
 if os.environ.get("OPENLEADS_SEARCH_MODE","local_forks")=="local_forks" and not c.execute("SELECT 1 FROM coverage_method_migrations WHERE method=?",(method,)).fetchone():
  changed=c.execute("UPDATE areas SET next_retry=NULL,last_error='provider_method_changed' WHERE source='directory' AND last_error IN ('zero_source_yield','no_machine_readable_yield')").rowcount
  c.execute("INSERT INTO coverage_method_migrations VALUES(?,?,?)",(method,now(),changed))
 c.commit()
 return c
def command(args,seconds=180):
 # Use the self-hosted search pair for VERIFICATION, not raw discovery.
 # Its existing positive-control preflight still blocks false clearance
 # whenever the local container or upstream indexes are unhealthy.
 env=os.environ.copy()
 if (len(args)>=2 and args[:2]==['-m','ops.local_law.screen_maps_websites'] or
     len(args)>=2 and args[:2] in (['-m','law_local.worker'],['-m','law_local.maps_first'])):
  env.setdefault('OPENLEADS_SEARCH_MODE','local_forks')
 return subprocess.run([PY,*args],cwd=SRC,text=True,capture_output=True,timeout=seconds,env=env)
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
       or "@" not in email or not ev.get("email_source")
       or not ev.get("checked_at") or not row["phone"]):
    continue
   checked=datetime.fromisoformat(ev["checked_at"].replace("Z","+00:00"))
   if checked.tzinfo is None or not timedelta(0)<=datetime.now(timezone.utc)-checked<=timedelta(days=30):continue
   qualified.append(dict(firm=row["firm"],phone=row["phone"],city=row["city"],state=row["state"],
     attorneys=ev.get("attorneys"),email=email,headcount_source=ev.get("headcount_source",""),
     email_source=ev["email_source"],site_status=ev["site_status"],checked_at=ev["checked_at"]))
  except (ValueError,TypeError,KeyError,AttributeError): continue
 # A shared office number or mailbox must not produce duplicate outreach.
 seen_phones=set();seen_emails=set();unique=[]
 for item in sorted(qualified,key=lambda x:(x["state"],x["firm"])):
  phone=''.join(ch for ch in item["phone"] if ch.isdigit())[-10:]
  email=item["email"].casefold()
  if phone in seen_phones or email in seen_emails:continue
  seen_phones.add(phone);seen_emails.add(email);unique.append(item)
 qualified=unique
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
  queue.export("call_qualified_no_email",ROOT/"phone-only-law.csv")
 finally:
  queue.close()
 print(json.dumps({"event":"calling_export","eligible_qualified":result,"file":str(ROOT/"call-qualified-law.csv")}))
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
        if isinstance(payload.get("official_ny_acquisition"),dict):
            return "candidates_added" if int(payload.get("added_unverified",0))>0 else "zero_source_yield"
        r=payload.get("fl_roster_profiles")
        if isinstance(r,dict):
            return "candidates_added" if int(r.get("added",0))>0 else "zero_source_yield"
    return "no_machine_readable_yield"

def harvey_cycle():
    """Mirror STRICT-only firms to Harvey, never start its outreach loop.

    Free OSM ingestion remains explicitly opt-in: volunteer Overpass mirrors
    recently returned HTTP 406/500. It must be healthy before scheduled use.
    """
    try:
        run=command(["-m","ops.local_law.harvey_bridge","sync-strict"],45)
        with (ROOT/"campaign-runs.log").open("a") as log:
            log.write(json.dumps(dict(time=now(),harvey_strict_sync_exit=run.returncode,
                         result=(run.stdout+run.stderr)[-380:]))+"\n")
    except (subprocess.TimeoutExpired,OSError) as exc:
        with (ROOT/"campaign-runs.log").open("a") as log:
            log.write(json.dumps(dict(time=now(),harvey_strict_sync_error=type(exc).__name__))+"\n")
    if os.environ.get("HARVEY_OSM_AUTOMATIC")!="1":
        return
    cities=("chicago","miami","houston","atlanta","philadelphia")
    city=cities[datetime.now(timezone.utc).toordinal()%len(cities)]
    try:
        scan=command(["-m","ops.local_law.harvey_bridge","discover-osm",
                      "--city",city,"--max","25"],175)
        with (ROOT/"campaign-runs.log").open("a") as log:
            log.write(json.dumps(dict(time=now(),harvey_osm_exit=scan.returncode,
                         research_result=(scan.stdout+scan.stderr)[-400:]))+"\n")
    except (subprocess.TimeoutExpired,OSError) as exc:
        with (ROOT/"campaign-runs.log").open("a") as log:
            log.write(json.dumps(dict(time=now(),harvey_osm_error=type(exc).__name__))+"\n")

def process_backlog():
    """Service pending candidates without ever bypassing site-proof gates.

    The worker performs its own provider preflight. A degraded search provider
    permits source-only research, never negative site certification.
    """
    try:
        result=command(["-m","law_local.worker","--db",str(DB),"run",
                        "--max","60","--workers","2","--seconds","240"],285)
        code=result.returncode
        output=(result.stdout+result.stderr)[-5000:]
    except subprocess.TimeoutExpired:
        code=124
        output="source_verifier_timeout"
    site_status="unknown"
    for line in output.splitlines():
        try:
            payload=json.loads(line)
        except (TypeError,ValueError):
            continue
        health=payload.get("site_provider_health")
        if isinstance(health,dict) and health.get("status"):
            site_status=health["status"]
    record=dict(time=now(),verify_exit=code,site_status=site_status,output=output)
    with (ROOT/"campaign-runs.log").open("a") as log:
        log.write(json.dumps(record)+"\n")
    return code

def cycle():
 import fcntl
 ROOT.mkdir(exist_ok=True)
 with (ROOT/"campaign.lock").open("w") as lock:
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError: print('another run is active');return 2
  from ops.local_law.any_size_policy import apply
  from ops.local_law.bridge_contacts import bridge
  log_record(dict(time=now(),any_size_migration=apply(ROOT)))
  log_record(dict(time=now(),email_source_bridge=bridge(ROOT,25)))
  # Restore saved historical raw Maps discoveries idempotently, avoiding a
  # second disconnected CSV queue. Old metadata is never evidence of no site.
  archived=ROOT/"research_archives/fl/maps/no-site-phone-candidates.csv"
  if archived.exists():
   try:
    restored=command(["-m","ops.local_law.restore_archived_maps","--csv",str(archived)],20)
    with (ROOT/"campaign-runs.log").open("a") as log:
     log.write(json.dumps(dict(time=now(),archived_maps_restore_exit=restored.returncode,
                              output=(restored.stdout+restored.stderr)[-700:]))+"\n")
   except subprocess.TimeoutExpired:
    with (ROOT/"campaign-runs.log").open("a") as log:
     log.write(json.dumps(dict(time=now(),archived_maps_restore_error="timeout"))+"\n")
  # Recover finished LOCAL Maps jobs into a separate unverified research queue.
  # No paid network services or Redis; site absence is never inferred from Maps.
  local_job=ROOT/"local-maps-pilot-job.json"
  if local_job.is_file():
   try:
    local=command(["-m","ops.local_law.ingest_local_maps","--job-file",str(local_job)],25)
    with (ROOT/"campaign-runs.log").open("a") as log:
     log.write(json.dumps(dict(time=now(),local_maps_import_exit=local.returncode,
                              output=(local.stdout+local.stderr)[-900:]))+"\n")
   except subprocess.TimeoutExpired:
    with (ROOT/"campaign-runs.log").open("a") as log:
     log.write(json.dumps(dict(time=now(),local_maps_import_error="timeout"))+"\n")
  # Plumbing-style acquisition rotation: ONE bounded small-market Maps job,
  # persisted and measured. Website verification is still independent.
  try:
   maps=command(["-m","ops.local_law.local_maps_controller"],30)
   with (ROOT/"campaign-runs.log").open("a") as log:
    log.write(json.dumps(dict(time=now(),local_maps_cycle_exit=maps.returncode,
                             output=(maps.stdout+maps.stderr)[-1000:]))+"\n")
  except subprocess.TimeoutExpired:
   with (ROOT/"campaign-runs.log").open("a") as log:
    log.write(json.dumps(dict(time=now(),local_maps_cycle_error="timeout"))+"\n")
  # Maps screening is research only; source identity and email still need proof.
  # Screen phone prospects directly
  # against independently functioning website-search providers; fail closed.
  try:
   screened=command(["-m","ops.local_law.screen_maps_websites","--max","12"],120)
   with (ROOT/"campaign-runs.log").open("a") as log:
    log.write(json.dumps(dict(time=now(),maps_site_screen_exit=screened.returncode,
                             output=(screened.stdout+screened.stderr)[-1400:]))+"\n")
  except subprocess.TimeoutExpired:
   with (ROOT/"campaign-runs.log").open("a") as log:
    log.write(json.dumps(dict(time=now(),maps_site_screen_error="timeout"))+"\n")
  # Reconnect Maps research to matched public firm profiles.
  try:
   sized=command(["-m","law_local.maps_first","--db",str(DB),
                  "--max-profiles","8","--seconds","65"],100)
   log_record(dict(time=now(),maps_headcount_exit=sized.returncode,
                   output=(sized.stdout+sized.stderr)[-1600:]))
  except subprocess.TimeoutExpired:
   log_record(dict(time=now(),maps_headcount_error="timeout"))
  # Publicly listed phone + no owned site field: a research prospect only.
  # Separate file so it cannot inflate qualified calls or email campaigns.
  try:
   exported=command(["-m","ops.local_law.export_maps_no_listed_site"],25)
   with (ROOT/"campaign-runs.log").open("a") as log:
    log.write(json.dumps(dict(time=now(),maps_research_export_exit=exported.returncode,
                             output=(exported.stdout+exported.stderr)[-600:]))+"\n")
  except subprocess.TimeoutExpired:
   with (ROOT/"campaign-runs.log").open("a") as log:
    log.write(json.dumps(dict(time=now(),maps_research_export_error="timeout"))+"\n")
  # Source-published email-first research; shared source crawl reservation and cache.
  try:
   irela=command(["-m","law_local.irela_source","--db",str(DB)],45)
   log_record(dict(time=now(),irela_contacts_exit=irela.returncode,output=(irela.stdout+irela.stderr)[-1200:]))
  except subprocess.TimeoutExpired:
   log_record(dict(time=now(),irela_contacts_error="timeout"))
  # Public Wisconsin local-bar officers: scoped law-office phone/email
  # with an active term, robots compliance and a one-day fetch cooldown.
  # Identity and independent website checks remain mandatory.
  try:
   wi=command(["-m","law_local.wisconsin_local_bars","--db",str(DB)],50)
   log_record(dict(time=now(),wisbar_contacts_exit=wi.returncode,
                   output=(wi.stdout+wi.stderr)[-1200:]))
  except subprocess.TimeoutExpired:
   log_record(dict(time=now(),wisbar_contacts_error="timeout"))
  # Official public active-lawyer contacts: bounded and persisted; no ID guessing.
  try:
   bar=command(["-m","law_local.wsba_source","--db",str(DB),"--seconds","45"],65)
   log_record(dict(time=now(),wsba_contacts_exit=bar.returncode,output=(bar.stdout+bar.stderr)[-1200:]))
  except subprocess.TimeoutExpired:
   log_record(dict(time=now(),wsba_contacts_error="timeout"))
  # Fresh source-published attorney business phone+email directory.
  # Revisit due states daily; unavailable sources cool down for 24 hours.
  # Never promote these records from source contacts or a negative site scan:
  # current private-practice status and source-published email remain gates.
  try:
   plea=command(["-m","ops.local_law.plea_source","ingest"],115)
   with (ROOT/"campaign-runs.log").open("a") as log:
    log.write(json.dumps(dict(time=now(),plea_source_ingest_exit=plea.returncode,
                             output=(plea.stdout+plea.stderr)[-650:]))+"\n")
  except subprocess.TimeoutExpired:
   with (ROOT/"campaign-runs.log").open("a") as log:
    log.write(json.dumps(dict(time=now(),plea_source_ingest_error="timeout"))+"\n")
  # Bounded research-only two-index check, with known-owned-site preflight.
  # Cap per hour to avoid hammering the upstream free search engines.
  try:
   plea_sites=command(["-m","ops.local_law.plea_source","audit-sites","--max","12"],160)
   with (ROOT/"campaign-runs.log").open("a") as log:
    log.write(json.dumps(dict(time=now(),plea_site_audit_exit=plea_sites.returncode,
                             output=(plea_sites.stdout+plea_sites.stderr)[-650:]))+"\n")
  except subprocess.TimeoutExpired:
   with (ROOT/"campaign-runs.log").open("a") as log:
    log.write(json.dumps(dict(time=now(),plea_site_audit_error="timeout"))+"\n")
  # Free, checkpointed directory discovery from Common Crawl's public index.
  # Real profile pages supply business phone and explicit owned-site links;
  # missing site link remains unverified and never auto-qualifies.
  try:
   cc=command(["-m","ops.local_law.commoncrawl_profiles","--max","12"],105)
   with (ROOT/"campaign-runs.log").open("a") as log:
    log.write(json.dumps(dict(time=now(),commoncrawl_exit=cc.returncode,output=(cc.stdout+cc.stderr)[-1200:]))+"\n")
  except subprocess.TimeoutExpired:
   with (ROOT/"campaign-runs.log").open("a") as log:
    log.write(json.dumps(dict(time=now(),commoncrawl_error="timeout"))+"\n")
  # Research the recovered 9,037-source pool incrementally before wasting discovery queries.
  archive_script=SRC/"ops/local_law/archive_triage.py"
  if archive_script.exists():
   try:
    triage=command(["ops/local_law/archive_triage.py","--max","25"],100)
    log_record(dict(time=now(),archive_triage_exit=triage.returncode,output=(triage.stdout+triage.stderr)[-1200:]))
   except subprocess.TimeoutExpired:
    log_record(dict(time=now(),archive_triage_error="timeout"))
  # Reuse historic source records in the original Mac verifier; bounded, no
  # duplicated archive or new service. Candidate import is NOT qualification.
  try:
   moved=command(["ops/local_law/bridge_archive.py","--max","20"],25)
   log_record(dict(time=now(),bridge_exit=moved.returncode,output=(moved.stdout+moved.stderr)[-500:]))
  except subprocess.TimeoutExpired:
   log_record(dict(time=now(),bridge_error="timeout"))
  # Keep a diverse private 1,000-row unverified research queue refreshed from
  # the existing 9,037 source-linked records. This is NOT the calling export.
  try:
   research=command(["-m","ops.local_law.export_review_shortlist"],35)
   with (ROOT/"campaign-runs.log").open("a") as log:
    log.write(json.dumps(dict(time=now(),research_queue_exit=research.returncode,
                             output=(research.stdout+research.stderr)[-1000:]))+"\n")
  except subprocess.TimeoutExpired:
   with (ROOT/"campaign-runs.log").open("a") as log:
    log.write(json.dumps(dict(time=now(),research_queue_error="timeout"))+"\n")
  cov=connect()
  rows=cov.execute("SELECT state FROM areas WHERE source='directory' AND state IN (" + ",".join("?" for _ in STATES) + ") AND (next_retry IS NULL OR next_retry <= ?) ORDER BY coalesce(last_attempt,'') LIMIT 1",(*STATES,now())).fetchall()
  if not rows:
   for st in STATES: cov.execute("INSERT OR IGNORE INTO areas(state,source) VALUES(?,'directory')",(st,))
   cov.commit()
   rows=cov.execute("SELECT state FROM areas WHERE source='directory' AND state IN (" + ",".join("?" for _ in STATES) + ") AND (next_retry IS NULL OR next_retry <= ?) ORDER BY coalesce(last_attempt,'') LIMIT 1",(*STATES,now())).fetchall()
  if not rows:
   print("no area due; processing existing verification queue")
   verify_exit=process_backlog()
   calling_export();strict_export();harvey_cycle()
   return 0 if verify_exit==0 else 1
  st=rows[0][0]
  started=now()
  if st=="NY":
   args=["-m","law_local.ny_contacts","--db",str(DB),"--max","20"]
  elif st=="FL":
   args=["-m","law_local.florida_roster","--db",str(DB),"--max-pages","3","--max-profiles","50","--seconds","90"]
  else:
   args=["-m","law_local.worker","--db",str(DB),"discover","--states",st,"--max-queries","5","--max-pages","25","--seconds","100","--delay","2"]
  error=""
  try:
   r=command(args,130);rc=r.returncode
   log=(r.stdout+"\n"+r.stderr)[-8000:]
   error=log[-1200:] if rc else ""
   outcome=discovery_result(rc,log)
   if outcome!="candidates_added":
    error=outcome
  except subprocess.TimeoutExpired:rc=124;log="deadline exceeded";error=log
  log_record(dict(time=started,state=st,exit=rc,output=log))
  success=bool(rc==0 and error=="")
  retry=(datetime.now(timezone.utc)+timedelta(days=7 if error=="zero_source_yield" else 1)).isoformat(timespec="seconds")
  cov.execute("UPDATE areas SET last_attempt=?,last_success=CASE WHEN ? THEN ? ELSE last_success END,next_retry=?,attempts=attempts+1,last_exit=?,last_error=? WHERE state=? AND city='' AND source='directory'",(started,int(success),now(),retry,rc,error,st))
  # Observed city records are candidate hints, not evidence of completed city coverage.
  for city,state in sqlite3.connect(DB).execute("SELECT DISTINCT city,state FROM candidates WHERE state=? AND trim(city)!=''",(st,)):
   cov.execute("INSERT OR IGNORE INTO areas(state,city,source,last_attempt) VALUES(?,?,'candidate_observed',?)",(state,city,now()))
  cov.commit()
  # A failed site provider still permits safe source-only processing.
  verify_exit=process_backlog()
  phone_count=calling_export()
  count=strict_export()
  harvey_cycle()
  if os.environ.get("LAW_SHEETS_CREDENTIALS"):
   sync=subprocess.run([str(ROOT/".venv/bin/python"),str(ROOT/"sync_sheet.py")],capture_output=True,text=True,timeout=120)
   log_record(dict(time=now(),sync_exit=sync.returncode,output=(sync.stdout+sync.stderr)[-1500:]))
  print(json.dumps(dict(state=st,discovery_exit=rc,verification_exit=verify_exit,calling_qualified=phone_count,strict_qualified=count)))
  return 0 if rc==0 and verify_exit==0 else 1
if __name__=="__main__":
 if len(sys.argv)>1 and sys.argv[1]=="export": calling_export();strict_export()
 elif len(sys.argv)>1 and sys.argv[1]=="coverage":
  con=connect();print(json.dumps([dict(zip(["state","city","source","last_attempt","last_success","next_retry","attempts","last_exit","last_error"],r)) for r in con.execute("SELECT * FROM areas ORDER BY state")]))
 else:sys.exit(scheduled_cycle())
