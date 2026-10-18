"""Production source-evidence census, not an eligibility generator.

Fetches only supplied public third-party profile URLs; writes CSV + JSON
diagnostics to the private GitHub Actions artifact. Zero promotions.
"""
from __future__ import annotations
import argparse
import csv
import json
import re
from collections import Counter
from concurrent.futures import ThreadPoolExecutor,as_completed
from html import unescape
from pathlib import Path
from urllib.parse import urlparse
from law_local.worker import (
    SqliteQueue,fetch_public,reader,firm_identity_matches,
    evaluate_published_source,normalize_phone,PHONE_RE,EMAIL_RE,
    _third_party,norm,
)

def raw_source_signals(html,lead):
    p=reader(html)
    text=" ".join(p.parts)
    firm=norm(lead["firm"])
    name_present=bool(len(firm)>=8 and firm in norm(text))
    phone=normalize_phone(lead["phone"])
    phones={normalize_phone(m.group()) for m in PHONE_RE.finditer(text)}
    phones.discard("")
    phone_present=phone in phones
    m=re.search(r"\b(?:firm size|office size|firm/organization size)\s*:?\s*"
        r"(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})(?!\d)",text,re.I)
    exact=re.search(r"\b(?:firm size|office size|number of attorneys|attorneys at this firm)\s*:?"
        r"\s*(\d{1,2})\s*(?:attorneys?|lawyers?)?\b",text,re.I) if not m else None
    size_range=None
    if m:
        size_range=[int(m.group(1)),int(m.group(2))]
    elif exact:
        size_range=[int(exact.group(1)),int(exact.group(1))]
    size_ok=bool(size_range and 2<=size_range[0]<=size_range[1]<=10)
    # A directory's official-site link is a positive ownership hint;
    # absence of that link is NOT positive proof of no owned website.
    owned=[]
    for url,label in p.links:
        if not re.search(r"(?i)\b(?:official website|visit site|visit website|firm website|website)\b",label or ""):
            continue
        h=(urlparse(url).hostname or "").lower()
        if h and not _third_party(h):
            owned.append(url)
        elif url.startswith("/") or (h and re.search(r"redirect|visit",url,re.I)):
            owned.append("directory_redirect_review:"+url[:120])
    emails={v.lower() for v in EMAIL_RE.findall(unescape(html))}
    emails={e for e in emails if not _third_party(e.split("@")[-1])}
    return {"name_match":name_present,"phone_match":phone_present,
        "explicit_size":size_ok,"size_range":size_range,
        "published_emails":len(emails),"owned_site_hints":len(owned),
        "owned_urls":sorted(set(owned))[:3]}

def check(lead):
    out=dict(lead)
    try:
        html=fetch_public(lead["source_url"],timeout=11)
        sig=raw_source_signals(html,lead)
        out.update(sig)
        out["http"]="200"
    except Exception as e:
        out.update({"http":"unavailable","error":str(e)[:160]})
    return out

def analyze(dbpath,outdir,maxrows=400,workers=6):
    db=SqliteQueue(dbpath)
    entries=[dict(x) for x in db.conn.execute(
        "SELECT firm,phone,city,state,source_url,status FROM candidates LIMIT ?",(maxrows,))]
    db.close()
    outdir=Path(outdir);outdir.mkdir(parents=True,exist_ok=True)
    results=[]
    with ThreadPoolExecutor(max_workers=max(1,min(10,workers))) as pool:
        pending=[pool.submit(check,x) for x in entries]
        for future in as_completed(pending):
            results.append(future.result())
    results.sort(key=lambda r:(r["state"],r["firm"]))
    report=Counter()
    group=Counter()
    for x in results:
        report["rows"]+=1
        k=x.get("http")
        report["source_http_"+str(k)]+=1
        if k!="200":
            group[(x["status"],"unavailable")]+=1
            continue
        for key in ("name_match","phone_match","explicit_size","owned_site_hints","published_emails"):
            if x.get(key):
                report[key]+=1
        if x.get("name_match") and x.get("explicit_size"): report["name_plus_size"]+=1
        if x.get("phone_match") and x.get("explicit_size"): report["phone_plus_size"]+=1
        if x.get("name_match") and x.get("phone_match") and x.get("explicit_size"):
            report["name_phone_size"]+=1
            if not x.get("owned_site_hints"):report["source_unlinked_size_phone"]+=1
        if x.get("name_match") and x.get("phone_match") and x.get("explicit_size") and x.get("owned_site_hints"):
            report["size_phone_has_owned_site_hint"]+=1
        group[(x["status"],"name"+str(int(x.get("name_match",False)))+"_phone"+str(int(x.get("phone_match",False)))+"_size"+str(int(x.get("explicit_size",False))))]+=1
    fields=["firm","phone","city","state","source_url","status","http","error",
        "name_match","phone_match","explicit_size","size_range","published_emails",
        "owned_site_hints","owned_urls"]
    with (outdir/"source-census.csv").open("w",newline="",encoding="utf-8") as f:
        w=csv.DictWriter(f,fieldnames=fields,extrasaction="ignore");w.writeheader()
        for row in results:w.writerow({k:json.dumps(v) if isinstance(v,list) else v for k,v in row.items()})
    payload={"counts":dict(report),"by_status_and_evidence":[
        {"status":a,"evidence":b,"count":n} for (a,b),n in group.most_common()],
        "warning":"Diagnostic only. No eligibility or no-owned-site assertions."}
    (outdir/"source-census-summary.json").write_text(json.dumps(payload,indent=2),encoding="utf-8")
    return payload

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--db",default="state/law-leads.sqlite3")
    p.add_argument("--out",default="state/audit")
    p.add_argument("--max",type=int,default=400)
    p.add_argument("--workers",type=int,default=6)
    args=p.parse_args()
    print(json.dumps(analyze(args.db,args.out,args.max,args.workers)),flush=True)
if __name__=="__main__":
    main()
