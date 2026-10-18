"""Official/member bar-directory firm-size-first sourcing.

Every imported row is a CANDIDATE, never a verified no-website firm.
Uses explicitly published professional firm and phone; an individual's
self-reported organization size is not an independent law-firm census.
"""
from __future__ import annotations
import argparse
import json
import re
import time
from urllib.parse import urlparse

from law_local.worker import (
    SqliteQueue, PHONE_RE, normalize_phone, fetch_public, reader, norm, utc_now
)

# Exact previously indexed public bar member profiles; no synthetic names,
# invented contact details, fabricated URL IDs, or guessed websites.
PUBLIC_BAR_SEEDS = (
    "https://www.inbar.org/members/Default.asp?id=29033429",
    "https://www.inbar.org/members/?id=29034873",
    "https://www.inbar.org/members/default.asp?id=80978621",
    "https://www.inbar.org/members/?id=29032900",
    "https://www.inbar.org/members/?id=29034873",
    "https://www.inbar.org/members/default.asp?id=78416764",
    "https://www.inbar.org/member/valeriecowan",
    "https://www.inbar.org/member/sethrwilson",
    "https://www.inbar.org/members/default.asp?id=82033630",
    "https://www.inbar.org/members/default.asp?id=29032211",
    "https://www.inbar.org/members/?id=72823200",
    "https://www.inbar.org/members/?id=64882060",
    "https://www.inbar.org/members/?id=74100685",
    "https://www.inbar.org/members/default.asp?id=81253607",
    "https://www.inbar.org/member/amy_dudas",
    "https://www.inbar.org/member/valeriecowan",
)
BAD_ORGANIZATIONS=(
    "circuit court","district court","superior court","supreme court",
    "court of appeals","united states government","department of",
    "judicial branch","office of the prosecutor","university",
    "legal services corporation","attorney general","law school",
    "county government","bar association",
)
ORG_TOKENS=("law","attorney","attorneys","lawyers","llp","pllc","p.c.","pc","counsel","legal","litigators","advocates")
SIZE_RE=re.compile(r"Firm\s*/\s*Organization\s+Size\s*:\s*([0-9]{1,3})\s*[-–]\s*([0-9]{1,3})\s*attorneys",re.I)

def permitted_bar_source(url):
    p=urlparse(str(url))
    return p.scheme=="https" and (p.hostname or "").lower() in {"www.inbar.org","inbar.org"} and (
        p.path.lower().startswith("/members/") or p.path.lower().startswith("/member/")
    )

def extract_inbar_firm(url,html):
    """Only publish an employer with a firm-specific 2–10 declaration and professional phone."""
    if not permitted_bar_source(url):
        return None,"untrusted_source"
    parts=[str(x).strip() for x in reader(html).parts if str(x).strip()]
    text=" ".join(parts)
    match=SIZE_RE.search(text)
    if not match or not (2<=int(match.group(1))<=int(match.group(2))<=10):
        return None,"missing_or_out_of_range_firm_size"
    try:
        start=next(i for i,v in enumerate(parts) if norm(v)=="professional information")
    except StopIteration:
        return None,"no_professional_section"
    try:
        end=next(i for i in range(start+1,len(parts))
                 if "county professional" in norm(parts[i]) or norm(parts[i])=="personal information")
    except StopIteration:
        end=min(len(parts),start+25)
    segment=parts[start+1:end]
    firm=None
    for x in segment[:7]:
        clean=" ".join(x.split())
        if 5<=len(clean)<=120 and any(t in clean.lower() for t in ORG_TOKENS) \
            and not any(t in clean.lower() for t in BAD_ORGANIZATIONS) \
            and not re.search(r"\b(?:email|website|phone|address)\b",clean,re.I):
            firm=clean
            break
    if not firm:
        return None,"no_private_law_firm"
    raw_contact=" ".join(segment)
    # The professional section may publish no phone; personal/mobile
    # numbers must not be substituted into a business-lead record.
    phones=[normalize_phone(m.group()) for m in PHONE_RE.finditer(raw_contact)]
    phones=[p for p in phones if p]
    if not phones:
        return None,"no_published_professional_phone"
    phone=phones[0]
    return {"firm":firm,"phone":phone,"state":"IN","city":"",
            "source_url":url},"candidate"

def bar_seed_harvest(db,urls=PUBLIC_BAR_SEEDS,fetch_fn=None,seconds=100,max_pages=30):
    fetch_fn=fetch_fn or fetch_public
    db.conn.execute("""CREATE TABLE IF NOT EXISTS bar_source_checks (
        url TEXT PRIMARY KEY, checked_at TEXT NOT NULL,
        reason TEXT NOT NULL, candidate_added INTEGER NOT NULL
    )""")
    db.conn.commit()
    out={"attempted":0,"successful_fetches":0,"fetch_failures":0,
         "size_phone_candidates":0,"candidates_added":0,"reasons":{}}
    deadline=time.monotonic()+max(1,int(seconds))
    for url in dict.fromkeys(urls):
        if time.monotonic()>=deadline or out["attempted"]>=max_pages:
            break
        if db.conn.execute("SELECT 1 FROM bar_source_checks WHERE url=?",(url,)).fetchone():
            continue
        out["attempted"]+=1
        try:
            html=fetch_fn(url,timeout=9)
            if len(html)<170:
                raise ValueError("body too short to attest public firm size")
            out["successful_fetches"]+=1
            lead,reason=extract_inbar_firm(url,html)
        except Exception as exc:
            out["fetch_failures"]+=1
            print(json.dumps({"event":"bar_source_failed","url":url,
                              "reason":str(exc)[:140]}),flush=True)
            continue
        out["reasons"][reason]=out["reasons"].get(reason,0)+1
        added=0
        if lead:
            out["size_phone_candidates"]+=1
            added=int(db.add(lead))
            out["candidates_added"]+=added
        db.conn.execute("INSERT OR IGNORE INTO bar_source_checks VALUES (?,?,?,?)",
                        (url,utc_now(),reason,added))
        db.conn.commit()
        print(json.dumps({"event":"bar_source","url":url,"status":reason,
                          "added":added}),flush=True)
        time.sleep(0.35)
    return out

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--db",default="state/law-leads.sqlite3")
    p.add_argument("--seconds",type=int,default=90)
    p.add_argument("--max-pages",type=int,default=30)
    args=p.parse_args()
    db=SqliteQueue(args.db)
    try:
        print(json.dumps({"bar_source":bar_seed_harvest(
            db,seconds=args.seconds,max_pages=args.max_pages),
            "counts":db.counts()}))
    finally:
        db.close()

if __name__=="__main__":
    main()
