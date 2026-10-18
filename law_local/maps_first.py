"""No-Maps-website-field law firm pipeline, with strict independent firm-size research.

A Maps missing website is merely an unverified acquisition signal. Never
treat it as proof of no owned website, 2–10 attorneys, or a usable email.
Direct directory URL probes are generated only from an actual named Maps
business, then rechecked against firm, phone and published firm-size evidence.
"""
from __future__ import annotations
import argparse
import csv
import json
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from law_local.search_sources import real_profile_urls
from law_local.maps_extract import COUNTRY_STATE
from law_local.worker import (
    SqliteQueue, _extract_directory_profile, normalize_phone, norm,
    fetch_public, utc_now, evaluate_published_source,
)

def ingest_maps_candidates(db,path):
    db.conn.execute("""CREATE TABLE IF NOT EXISTS maps_raw_candidates (
        map_id TEXT PRIMARY KEY, firm TEXT NOT NULL, phone TEXT NOT NULL,
        state TEXT NOT NULL, maps_url TEXT NOT NULL, added_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unverified_headcount',
        city TEXT NOT NULL DEFAULT ''
    )""")
    db.conn.execute("""CREATE TABLE IF NOT EXISTS maps_profile_checks (
        map_id TEXT NOT NULL, url TEXT NOT NULL,
        checked_at TEXT NOT NULL, status TEXT NOT NULL,
        PRIMARY KEY(map_id,url)
    )""")
    existing={r[1] for r in db.conn.execute("PRAGMA table_info(maps_raw_candidates)")}
    if "city" not in existing:
        db.conn.execute("ALTER TABLE maps_raw_candidates ADD COLUMN city TEXT NOT NULL DEFAULT ''")
    inserted=0
    with Path(path).open(newline="",encoding="utf-8-sig") as fd:
        for row in csv.DictReader(fd):
            firm=(row.get("firm") or "").strip()
            phone=normalize_phone(row.get("phone") or "")
            state=(row.get("state") or "").strip()
            city=(row.get("city") or "").strip()
            # Must come from a public Maps record whose site field was blank;
            # never infer website absence from missing or malformed metadata.
            if not firm or not phone or row.get("website_status")!="no_maps_website_field_only":
                continue
            key=norm(firm)+"|"+phone
            inserted+=int(db.conn.execute(
                """INSERT OR IGNORE INTO maps_raw_candidates
                    (map_id,firm,phone,state,maps_url,added_at,status,city)
                    VALUES (?,?,?,?,?,?,?,?)""",
                (key,firm,phone,state,row.get("maps_source",""),utc_now(),
                 "unverified_headcount",city)).rowcount>0)
            # Earlier Maps runs lost city/state when addresses ended in "United States".
            # Improve their provenance without resetting any research checkpoint.
            db.conn.execute("""UPDATE maps_raw_candidates SET
                 city=CASE WHEN city='' THEN ? ELSE city END,
                 state=CASE WHEN state='' THEN ? ELSE state END
                 WHERE map_id=?""",(city,state,key))
    db.conn.commit()
    return inserted

def verify_map_headcounts(db,fetch_fn=None,seconds=100,max_profiles=30,source_resolver=None):
    fetch_fn=fetch_fn or fetch_public
    source_resolver=source_resolver or (lambda firm,city,state: real_profile_urls(
        firm,city,state,fetch_fn=fetch_fn))
    # Do not repeat an unproductive result every single bounded GitHub run.
    # Empty search results are a discovery limitation, never site evidence.
    db.conn.execute("""CREATE TABLE IF NOT EXISTS maps_source_search_checks (
        map_id TEXT NOT NULL, method TEXT NOT NULL,
        checked_at TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY(map_id,method)
    )""")
    db.conn.commit()
    method="bing_rss_real_profiles_v1"
    cutoff=(datetime.now(timezone.utc)-timedelta(days=7)).isoformat()
    deadline=time.monotonic()+max(1,int(seconds))
    counts={"maps_checked":0,"source_cooldown_skips":0,
            "searches":0,"responsive_searches":0,
            "actual_directory_links":0,"profile_requests":0,
            "identity_phone_size_matches":0,
            "added_to_final_audit":0,"fetch_failures":0,"directory_hits":0}
    raw=db.conn.execute("""SELECT * FROM maps_raw_candidates
        WHERE status='unverified_headcount' ORDER BY added_at LIMIT 100""").fetchall()
    for record in raw:
        if time.monotonic()>=deadline or counts["profile_requests"]>=max_profiles:
            break
        prior=db.conn.execute(
            "SELECT checked_at,result FROM maps_source_search_checks WHERE map_id=? AND method=?",
            (record["map_id"],method)).fetchone()
        if prior and prior["checked_at"]>cutoff and prior["result"]=="no_relevant_indexed_firm_profiles":
            counts["source_cooldown_skips"]+=1
            continue
        had_match=False
        counts["searches"]+=1
        try:
            source_results=source_resolver(record["firm"],record["city"],record["state"])
        except Exception as exc:
            print(json.dumps({"event":"firm_source_lookup_failed",
                 "firm":record["firm"],"error":str(exc)[:150]}),flush=True)
            continue
        # Search outages are never "no firm" or proof of no website.
        if not source_results.get("responded"):
            print(json.dumps({"event":"firm_source_unavailable","firm":record["firm"]}),flush=True)
            continue
        counts["responsive_searches"]+=1
        candidates=source_results.get("urls",[])
        counts["actual_directory_links"]+=len(candidates)
        if not candidates:
            db.conn.execute("""INSERT INTO maps_source_search_checks
                (map_id,method,checked_at,result) VALUES (?,?,?,?)
                ON CONFLICT(map_id,method) DO UPDATE SET
                checked_at=excluded.checked_at,result=excluded.result""",
                (record["map_id"],method,utc_now(),"no_relevant_indexed_firm_profiles"))
            db.conn.commit()
            print(json.dumps({"event":"no_real_indexed_directory_source",
                "firm":record["firm"],"reason":"RSS returned zero applicable source URLs",
                "retry_days":7}),flush=True)
            counts["maps_checked"]+=1
            continue
        for url in candidates:
            if time.monotonic()>=deadline or counts["profile_requests"]>=max_profiles:
                break
            prev=db.conn.execute("SELECT 1 FROM maps_profile_checks WHERE map_id=? AND url=?",
                                 (record["map_id"],url)).fetchone()
            if prev:
                continue
            counts["profile_requests"]+=1
            try:
                html=fetch_fn(url,timeout=8)
                if len(html)<150:
                    raise ValueError("not a firm profile page")
            except Exception:
                counts["fetch_failures"]+=1
                # HTML 404 / unavailable are retryable, bounded by caller,
                # never proof this company has no attorney-size evidence.
                continue
            counts["directory_hits"]+=1
            candidate=None
            if "lawyer.com/" in url:
                candidate=_extract_directory_profile(url,html)
                if candidate and (candidate["phone"]!=record["phone"] or
                                  norm(candidate["firm"])!=norm(record["firm"])):
                    candidate=None
            else:
                lead={"firm":record["firm"],"phone":record["phone"],
                      "city":record["city"],"state":record["state"],
                      "source_url":url}
                evidence=evaluate_published_source(html,lead)
                if 2<=evidence["attorneys"]<=10:
                    candidate=lead
            status="not_matching_sourced_size_phone"
            if candidate:
                candidate["state"]=record["state"]
                candidate["city"]=record["city"]
                counts["identity_phone_size_matches"]+=1
                counts["added_to_final_audit"]+=int(db.add(candidate))
                status="candidate_for_independent_website_and_email_check"
                had_match=True
            db.conn.execute("""INSERT OR IGNORE INTO maps_profile_checks
                  VALUES (?,?,?,?)""",(record["map_id"],url,utc_now(),status))
            db.conn.commit()
            if had_match:
                break
        db.conn.execute("UPDATE maps_raw_candidates SET status=? WHERE map_id=?",
                         ("pending_independent_site_audit" if had_match else "unverified_headcount",record["map_id"]))
        db.conn.commit()
        counts["maps_checked"]+=1
    return counts

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--db",default="state/law-leads.sqlite3")
    p.add_argument("--csv",required=True)
    p.add_argument("--seconds",type=int,default=90)
    p.add_argument("--max-profiles",type=int,default=30)
    args=p.parse_args()
    db=SqliteQueue(args.db)
    try:
        imported=ingest_maps_candidates(db,args.csv)
        verified=verify_map_headcounts(db,seconds=args.seconds,max_profiles=args.max_profiles)
        print(json.dumps({"maps_imported":imported,"maps_headcount":verified,
                          "counts":db.counts()}))
    finally:
        db.close()

if __name__=="__main__":
    main()
