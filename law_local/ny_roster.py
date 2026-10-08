"""Official NY Open Data law-business discovery, safely distinguishing NY registrants from firm size.

Grouping by company_name + business phone + city reports NY-registered
attorneys only. It is NOT proof the law firm has only N lawyers nationwide.
Never advance grouped records to calling_qualified or strict_eligible.
"""
from __future__ import annotations
import argparse
import csv
import json
import re
import sqlite3
import time
import hashlib
from pathlib import Path
from urllib.parse import urlencode
from law_local.worker import SqliteQueue,normalize_phone,norm,utc_now,fetch_public
from law_local.florida_roster import clearly_non_law_employer

ROOT="https://data.ny.gov/resource/eqw2-r5nb.json"
DATASET="https://data.ny.gov/Transparency/NYS-Attorney-Registrations/eqw2-r5nb"
QUERY_WHERE="status='Currently registered' AND company_name IS NOT NULL AND phone_number IS NOT NULL AND state='NY'"
NAME_PROFESSIONAL=re.compile(
    r"\b(?:law|attorneys?|lawyers?|legal|counsel|esquire|esq|litigation|"
    r"llp|pllc|p\.?c\.?|p\.?a\.?)\b",re.I)
PAIR=re.compile(r"\b[A-Za-z][A-Za-z.'-]{2,}\s*(?:&| AND )\s*[A-Za-z][A-Za-z.'-]{2,}",re.I)
GENERIC_LOCATION=re.compile(r"^\s*(?:\d+\s+[A-Z]+\s+(?:STREET|ROAD|AVE|AVENUE|PLAZA)|P\.?O\.?\s+BOX)\b",re.I)

def evidence_class(company):
    company=" ".join(str(company or "").split())
    if len(company)<7 or GENERIC_LOCATION.search(company):
        return "not_law_business"
    if clearly_non_law_employer(company):
        return "not_law_business"
    if NAME_PROFESSIONAL.search(company) or PAIR.search(company):
        return "possible_private_law_firm"
    return "unverified_practice_identity"

def query_url(limit=500,offset=0):
    params={
        "$select":"company_name,phone_number,city,state,count(*) as ny_attorneys",
        "$where":QUERY_WHERE,
        "$group":"company_name,phone_number,city,state",
        "$having":"count(*) between 2 and 10",
        "$order":"company_name,phone_number,city",
        "$limit":int(limit),"$offset":int(offset)
    }
    return ROOT+"?"+urlencode(params)

def parse_groups(data):
    rows=[]
    for item in data:
        company=" ".join(str(item.get("company_name") or "").split())
        phone=normalize_phone(item.get("phone_number") or "")
        try:count=int(item.get("ny_attorneys") or 0)
        except (ValueError,TypeError):continue
        if not company or not phone or count<2 or count>10:
            continue
        status=evidence_class(company)
        rows.append({"company":company,"phone":phone,"city":str(item.get("city") or "").strip(),
                     "state":"NY","ny_attorneys":count,
                     "source_url":DATASET,"status":status})
    return rows

def ensure(db):
    db.conn.executescript("""CREATE TABLE IF NOT EXISTS ny_registration_groups (
        id TEXT PRIMARY KEY, company TEXT NOT NULL, phone TEXT NOT NULL,
        city TEXT NOT NULL, state TEXT NOT NULL, ny_attorneys INTEGER NOT NULL,
        source_url TEXT NOT NULL, status TEXT NOT NULL, checked_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ny_registration_pages (
        source_version TEXT NOT NULL,page_offset INTEGER NOT NULL,
        count INTEGER NOT NULL,completed_at TEXT NOT NULL,
        PRIMARY KEY(source_version,page_offset));""")
    db.conn.commit()

def collect(db,fetch_fn=None,max_pages=6,page_size=500,seconds=110):
    ensure(db)
    fetch_fn=fetch_fn or fetch_public
    deadline=time.monotonic()+max(1,int(seconds))
    v="currently_registered_ny_groups_v1"
    stats={"pages":0,"groups_fetched":0,"rows_with_valid_phone":0,
           "possible_private_law_firms":0,"source_groups_stored":0,
           "pages_skipped":0,"source_errors":0}
    for idx in range(max(1,int(max_pages))):
        offset=idx*page_size
        if time.monotonic()>=deadline:
            break
        if db.conn.execute("SELECT 1 FROM ny_registration_pages WHERE source_version=? AND page_offset=?",
                           (v,offset)).fetchone():
            stats["pages_skipped"]+=1
            continue
        try:
            payload=fetch_fn(query_url(page_size,offset),timeout=15)
            values=json.loads(payload)
            if not isinstance(values,list):
                raise ValueError("NY data source not JSON records")
        except Exception as exc:
            stats["source_errors"]+=1
            print(json.dumps({"event":"ny_source_error","offset":offset,"reason":str(exc)[:150]}),flush=True)
            break
        groups=parse_groups(values)
        stats["groups_fetched"]+=len(values)
        stats["rows_with_valid_phone"]+=len(groups)
        stats["possible_private_law_firms"]+=sum(x["status"]=="possible_private_law_firm" for x in groups)
        for row in groups:
            key=hashlib.sha256((norm(row["company"])+"|"+row["phone"]+"|"+norm(row["city"])).encode()).hexdigest()[:24]
            result=db.conn.execute("""INSERT OR IGNORE INTO ny_registration_groups
                (id,company,phone,city,state,ny_attorneys,source_url,status,checked_at)
                VALUES (?,?,?,?,?,?,?,?,?)""",
                (key,row["company"],row["phone"],row["city"],row["state"],row["ny_attorneys"],
                 row["source_url"],row["status"],utc_now()))
            stats["source_groups_stored"]+=int(result.rowcount>0)
        db.conn.execute("INSERT INTO ny_registration_pages VALUES (?,?,?,?)",
                        (v,offset,len(values),utc_now()))
        db.conn.commit()
        stats["pages"]+=1
        print(json.dumps({"event":"ny_group_page","offset":offset,"groups":len(values),
                          "valid_phones":len(groups),"stored":stats["source_groups_stored"]}),flush=True)
        if len(values)<page_size:
            break
        # Public Socrata API: keep rate polite and avoid needless bursts.
        time.sleep(0.2)
    stats["total_groups"]=db.conn.execute("SELECT COUNT(*) FROM ny_registration_groups").fetchone()[0]
    stats["possible_private_firm_groups"]=db.conn.execute(
        "SELECT COUNT(*) FROM ny_registration_groups WHERE status='possible_private_law_firm'").fetchone()[0]
    stats["warning"]="NY registration group count is NOT a verified worldwide attorney headcount; email and owned-site status both unknown."
    return stats

def export(db,path):
    path=Path(path)
    path.parent.mkdir(parents=True,exist_ok=True)
    rows=db.conn.execute("""SELECT company,ny_attorneys,phone,city,state,status,source_url
        FROM ny_registration_groups ORDER BY company,city""").fetchall()
    with path.open("w",newline="",encoding="utf-8") as fd:
        w=csv.writer(fd)
        w.writerow(["Law firm / employer","NY registered attorneys observed","Business phone","Email",
                    "City","State","Private law practice status","No-owned-site status","Official data source"])
        for r in rows:
            w.writerow([r["company"],r["ny_attorneys"],r["phone"],"",r["city"],r["state"],
                        r["status"],"NOT VERIFIED",r["source_url"]])
    return len(rows)

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--db",default="state/law-leads.sqlite3")
    p.add_argument("--max-pages",type=int,default=6)
    p.add_argument("--page-size",type=int,default=500)
    p.add_argument("--seconds",type=int,default=110)
    p.add_argument("--out",default="state/ny-source-groups.csv")
    args=p.parse_args()
    db=SqliteQueue(args.db)
    try:
        result=collect(db,max_pages=args.max_pages,page_size=args.page_size,seconds=args.seconds)
        result["export_rows"]=export(db,args.out)
        print(json.dumps({"ny_open_data":result}),flush=True)
    finally:db.close()
if __name__=="__main__":
    main()
