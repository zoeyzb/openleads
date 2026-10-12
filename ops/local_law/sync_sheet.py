#!/usr/bin/env python3
"""Non-destructive source-verified phone calling queue Sheets upsert."""
import csv, hashlib, json, os, subprocess, sys, time
from pathlib import Path
from datetime import datetime,timezone
ROOT=Path.home()/"lead-workspace"
SHEET="1iKfhmIZCi3vcwsfI5Dlwg2rhQtqi-5zPkrlGmfxs42M"
TAB="Verified Calling Queue"
def key(r):
 return hashlib.sha256((r["Firm"].casefold().strip()+"|"+r["Phone"]+"|"+r["State"].upper().strip()).encode()).hexdigest()[:24]
def rows():
 p=subprocess.run(["/opt/homebrew/bin/python3.11",str(ROOT/"campaign.py"),"export"],capture_output=True,text=True,check=True)
 with (ROOT/"call-qualified-law.csv").open(newline="") as f:
  for r in csv.DictReader(f):
   if not (r.get("Headcount source") and r.get("Website audit")=="screened_no_site" and 2<=int(r.get("Attorneys") or 0)<=10 and r.get("Phone")):continue
   yield r
def preview():
 batch=[]
 for r in rows():
  batch.append([r["Firm"],r["Phone"],r["Attorneys"],r["City"],r["State"],r["Headcount source"],
    r["Website audit"],r["Checked at"],r.get("Email",""),r.get("Email source",""),key(r)])
 print(json.dumps({"event":"calling_queue_preview","count":len(batch),"sample":batch[:3]}))
 return batch

def run():
 if "--preview" in sys.argv:
  preview()
  return 0
 creds=os.environ.get("LAW_SHEETS_CREDENTIALS","")
 if not creds or not Path(creds).is_file():
  print("SHEETS_SYNC_BLOCKED: supply LAW_SHEETS_CREDENTIALS pointing to a dedicated authorized service-account JSON; no rows changed")
  return 3
 try:
  from google.oauth2 import service_account
  from google.auth.transport.requests import AuthorizedSession
 except ImportError:
  print("SHEETS_SYNC_BLOCKED: install google-auth and requests into an isolated environment")
  return 3
 auth=service_account.Credentials.from_service_account_file(creds,scopes=["https://www.googleapis.com/auth/spreadsheets"])
 session=AuthorizedSession(auth)
 url="https://sheets.googleapis.com/v4/spreadsheets/"+SHEET+"/values/"
 import urllib.parse
 def request(method,range_or_op,body=None,params=None):
  path=urllib.parse.quote(range_or_op,safe="!:'")
  for attempt in range(5):
   res=session.request(method,url+path,json=body,params=params,timeout=35)
   if res.status_code in (429,500,502,503,504):
    time.sleep(min(2**attempt,16));continue
   res.raise_for_status();return res.json()
  raise RuntimeError("Sheets returned repeated retryable errors")
 existing=request("GET",TAB+"!K2:K100000").get("values",[])
 mapping={row[0]:i+2 for i,row in enumerate(existing) if row and row[0]}
 now=datetime.now(timezone.utc).isoformat(timespec="seconds")
 updates=[]
 appended=[]
 for r in rows():
  k=key(r)
  v=[r["Firm"],r["Phone"],r["Attorneys"],r["City"],r["State"],r["Headcount source"],r["Website audit"],r["Checked at"],r.get("Email",""),r.get("Email source",""),k,now]
  if k in mapping:
   updates.append({"range":f"'{TAB}'!A{mapping[k]}:L{mapping[k]}","values":[v]})
  else:
   mapping[k]=-(len(appended)+1)
   appended.append(v)
 # Do not delete rows, overwrite headers, or treat pending leads as strict.
 for start in range(0,len(updates),100):
  request("POST","batchUpdate",{"valueInputOption":"RAW","data":updates[start:start+100]})
 for start in range(0,len(appended),200):
  request("POST",TAB+"!A:L:append",{"values":appended[start:start+200]},
          {"valueInputOption":"RAW","insertDataOption":"INSERT_ROWS"})
 print(json.dumps({"event":"sheet_sync","phone_rows_checked":len(updates)+len(appended),"updated":len(updates),"new":len(appended)}))
 return 0
if __name__=="__main__":
 try:sys.exit(run())
 except Exception as exc:print("SHEETS_SYNC_FAILED:",type(exc).__name__,str(exc)[:300],file=sys.stderr);sys.exit(1)
