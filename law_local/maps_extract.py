"""Recover honest law-firm candidates from saved Google Maps scraper CSV output.

The Maps collector sometimes exits/cancels with partial results. This module
converts its raw, source-linked CSV into *unverified candidates* on a separate
step. No absent Maps website field proves absence of a firm-owned website.
"""
from __future__ import annotations
import argparse
import csv
import json
import re
from collections import Counter
from pathlib import Path
from urllib.parse import urlparse
from law_local.worker import normalize_phone, norm

FIELDNAMES=("firm","phone","city","state","maps_source","website_status",
            "headcount_status","email_status","original_address")
COUNTRY_STATE={
    "alabama":"AL","alaska":"AK","arizona":"AZ","arkansas":"AR","california":"CA",
    "colorado":"CO","connecticut":"CT","delaware":"DE","florida":"FL","georgia":"GA",
    "hawaii":"HI","idaho":"ID","illinois":"IL","indiana":"IN","iowa":"IA",
    "kansas":"KS","kentucky":"KY","louisiana":"LA","maine":"ME","maryland":"MD",
    "massachusetts":"MA","michigan":"MI","minnesota":"MN","mississippi":"MS",
    "missouri":"MO","montana":"MT","nebraska":"NE","nevada":"NV","new hampshire":"NH",
    "new jersey":"NJ","new mexico":"NM","new york":"NY","north carolina":"NC",
    "north dakota":"ND","ohio":"OH","oklahoma":"OK","oregon":"OR","pennsylvania":"PA",
    "rhode island":"RI","south carolina":"SC","south dakota":"SD","tennessee":"TN",
    "texas":"TX","utah":"UT","vermont":"VT","virginia":"VA","washington":"WA",
    "west virginia":"WV","wisconsin":"WI","wyoming":"WY",
}
STATE_CODES=set(COUNTRY_STATE.values())
LAW_SIGNAL=re.compile(r"\b(law|legal|attorneys?|lawyers?|counsel)\b",re.I)
NON_FIRM=re.compile(
    r"\b(bail bonds?|court reporters?|process servers?|notary|paralegal|"
    r"legal aid|legal clinics?|law schools?|court(?:house)?|prosecutors?|"
    r"district attorneys?|state attorneys?|county attorneys?|public defenders?|"
    r"attorney general|bar associations?|real estate|title company)\b",re.I)
EMPTY_WEB={"", "null", "none", "n/a", "na", "-", "no website"}

def state_from_address(address):
    address=str(address or "").strip()
    m=re.search(r",\s*([A-Z]{2})\s*(?:\d{5}(?:-\d{4})?)?\s*(?:,?\s*USA)?\s*$",address)
    if m and m.group(1) in STATE_CODES:
        return m.group(1)
    for name,code in COUNTRY_STATE.items():
        if re.search(r"\b"+re.escape(name)+r"\b",address,re.I):
            return code
    return ""

def maps_candidate(row):
    name=" ".join(str(row.get("title") or row.get("name") or "").split())
    category=str(row.get("category") or "")
    address=str(row.get("address") or "")
    phone=normalize_phone(row.get("phone") or "")
    website=str(row.get("website") or "").strip()
    link=str(row.get("link") or "").strip()
    p=urlparse(link)
    host=(p.hostname or "").lower()
    if not name or not phone or p.scheme!="https" or host not in (
        "www.google.com","google.com","maps.google.com"):
        return None,"no_source_identity_or_phone"
    if website.lower() not in EMPTY_WEB:
        return None,"website_field_present"
    if not LAW_SIGNAL.search(name+" "+category) or NON_FIRM.search(name+" "+category):
        return None,"not_private_law_firm"
    return {
        "firm":name,"phone":phone,"city":"","state":state_from_address(address),
        "maps_source":link,"website_status":"no_maps_website_field_only",
        "headcount_status":"unverified","email_status":"unverified",
        "original_address":address,
    },"candidate"

def extract(raw_path,out_path,summary_path=None):
    raw_path=Path(raw_path)
    out_path=Path(out_path)
    out_path.parent.mkdir(parents=True,exist_ok=True)
    counts=Counter()
    seen=set()
    rows=[]
    if raw_path.is_file():
        with raw_path.open(newline="",encoding="utf-8-sig") as fd:
            for row in csv.DictReader(fd):
                counts["raw_rows"]+=1
                cand,reason=maps_candidate(row)
                counts[reason]+=1
                if not cand:
                    continue
                key=(norm(cand["firm"]),cand["phone"])
                if key in seen:
                    counts["duplicates"]+=1
                    continue
                seen.add(key)
                rows.append(cand)
    else:
        counts["raw_file_missing"]+=1
    with out_path.open("w",newline="",encoding="utf-8") as fd:
        wr=csv.DictWriter(fd,fieldnames=FIELDNAMES)
        wr.writeheader()
        wr.writerows(rows)
    result={"raw_rows":counts["raw_rows"],
            "maps_no_site_phone_candidates":len(rows),
            "strict_eligible_verified":0,
            "reason_counts":dict(counts),
            "note":"Candidate stage only. Requires separate published 2-10 attorney, independent no-owned-website and source-verified email checks."}
    if summary_path:
        path=Path(summary_path)
        path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(json.dumps(result,indent=2),encoding="utf-8")
    return result

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--raw",required=True)
    p.add_argument("--out",required=True)
    p.add_argument("--summary")
    args=p.parse_args()
    print(json.dumps(extract(args.raw,args.out,args.summary)))

if __name__=="__main__":
    main()
