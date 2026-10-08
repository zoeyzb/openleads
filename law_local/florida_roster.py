"""Source-first public FL Bar-derived firm roster discovery; no hosted worker.

Published /firms listing gives current active-member headcounts, then exact
/firm/ pages ground the firm name, attorney count, and business phone.
ALL leads remain unqualified for no-owned-website/email until the
independent verifier succeeds. No guessed profile URLs or fake emails.
"""
from __future__ import annotations
import argparse
import csv
import json
import re
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor,as_completed
from html import unescape
from pathlib import Path
from urllib.parse import urljoin,urlparse
from urllib import robotparser
from law_local.worker import (
    SqliteQueue,fetch_public,reader,normalize_phone,norm,utc_now
)

ROOT="https://www.floridalawdirectory.com"
FIRM_PREFIX=ROOT+"/firm/"
COUNT_LIST=re.compile(r"\b(\d{1,4})\s+active\s+attorney",re.I)
COUNT_PROFILE=re.compile(r"\bAttorneys\s+(\d{1,4})\s+active\b",re.I)
PHONE_PROFILE=re.compile(r"\bPhone\s+(\(?[2-9]\d{2}\)?[\s.()-]*[2-9]\d{2}[\s.()-]*\d{4})",re.I)
NON_PRIVATE=re.compile(
    r"\b(?:state attorney|public defender|office of regional counsel|"
    r"office of the attorney general|county attorney|city attorney|"
    r"department of|county government|circuit court|judicial circuit|"
    r"courthouse|legal aid society|university|law school|"
    r"department of justice|bank|mortgage|insurance company)\b",re.I)
H1=re.compile(r"<h1\b[^>]*>(.*?)</h1>",re.I|re.S)
# Roster includes in-house counsel at businesses. A size count by itself
# NEVER proves an organization is a private law firm.
NON_LAW_BUSINESS=re.compile(
    r"\b(?:realty|realtors?|properties|property management|"
    r"construction|builders?|development|holdings|investments?|"
    r"manufacturing|foodservice|hospital|healthcare|medical center|"
    r"electric|utility|power company|university|insurance|"
    r"engineering|logistics|transport|financial services|"
    r"mortgage|automotive|restaurant|resort|hotel|retail|"
    r"supermarket|communications|telecom|pharmaceutical)\b",re.I)
LAW_PRACTICE_SIGNAL=re.compile(
    r"\b(?:law(?:\s+(?:firm|office|offices|group|practice))?|"
    r"attorneys?|lawyers?|legal(?:\s+(?:group|services|counsel))?|"
    r"counsel|litigation|esq)\b",re.I)
def clearly_non_law_employer(firm):
    raw=str(firm or "")
    if NON_LAW_BUSINESS.search(raw):
        return True
    if re.search(r"\b(?:inc|corp|corporation|company|co)\.?\b",raw,re.I) and not LAW_PRACTICE_SIGNAL.search(raw):
        return True
    return False

def allowed_profile(url):
    p=urlparse(str(url))
    return p.scheme=="https" and (p.hostname or "").lower()=="www.floridalawdirectory.com" \
        and p.path.startswith("/firm/") and len(p.path)>len("/firm/") and not p.query

def robots_permits(fetch_fn=fetch_public):
    raw=fetch_fn(ROOT+"/robots.txt",timeout=10)
    rp=robotparser.RobotFileParser()
    rp.parse(raw.splitlines())
    return all(rp.can_fetch("OpenLeads-Law-Evidence",ROOT+p)
               for p in ("/firms","/firms?page=2","/firm/haas-law-pllc"))

def listing_firms(html):
    p=reader(html)
    all_links=0
    qualifying=[]
    for href,label in p.links:
        target=urljoin(ROOT,href)
        if not allowed_profile(target):
            continue
        all_links+=1
        text=" ".join((label or "").split())
        m=COUNT_LIST.search(text)
        if not m:
            continue
        count=int(m.group(1))
        if 2<=count<=10:
            qualifying.append((target,count))
    # Distinct profile hrefs are authoritative; ignore duplicates in nav/footer.
    return {"all_profiles":all_links,"candidates":list(dict.fromkeys(qualifying))}

def parse_roster_profile(html,url):
    if not allowed_profile(url):
        return None,"not_published_firm_url"
    headers=H1.findall(html)
    if not headers:
        return None,"missing_h1"
    firm=" ".join(unescape(re.sub(r"(?s)<[^>]+>"," ",headers[0])).split()).strip()
    if len(norm(firm))<7 or NON_PRIVATE.search(firm) or clearly_non_law_employer(firm):
        return None,"not_private_firm"
    text=" ".join(reader(html).parts)
    m=COUNT_PROFILE.search(text)
    if not m:
        return None,"missing_current_active_count"
    count=int(m.group(1))
    if not 2<=count<=10:
        return None,"outside_2_to_10"
    top=text.split("Active attorneys (",1)[0]
    phone_match=PHONE_PROFILE.search(top)
    phone=normalize_phone(phone_match.group(1)) if phone_match else ""
    if not phone:
        return None,"missing_business_phone"
    return {"firm":firm,"phone":phone,"state":"FL","city":"",
            "source_url":url,"published_active_attorneys":count},"size_phone_source_only"

def ensure_tables(db):
    db.conn.executescript("""
      CREATE TABLE IF NOT EXISTS fl_roster_pages (
        page INTEGER PRIMARY KEY, checked_at TEXT NOT NULL,
        profiles_seen INTEGER NOT NULL, candidates INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fl_roster_frontier (
        url TEXT PRIMARY KEY, listed_attorneys INTEGER NOT NULL,
        discovered_at TEXT NOT NULL, checked_at TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE IF NOT EXISTS fl_roster_prior_sources (
        candidate_id TEXT NOT NULL, old_source TEXT NOT NULL,
        old_status TEXT NOT NULL, replaced_at TEXT NOT NULL,
        PRIMARY KEY(candidate_id,old_source)
      );
    """)
    db.conn.commit()

def discover_listings(db,fetch_fn=fetch_public,max_pages=156,seconds=150,
                      polite_wait=0.3):
    ensure_tables(db)
    stats=Counter()
    deadline=time.monotonic()+max(1,seconds)
    for page in range(1,min(156,max_pages)+1):
        if time.monotonic()>=deadline:
            break
        if db.conn.execute("SELECT 1 FROM fl_roster_pages WHERE page=?",(page,)).fetchone():
            stats["pages_checkpointed"]+=1
            continue
        url=ROOT+"/firms"+(f"?page={page}" if page>1 else "")
        try:
            html=fetch_fn(url,timeout=11)
            found=listing_firms(html)
            if found["all_profiles"]<5:
                raise ValueError("not a real firm-directory listing")
        except Exception as e:
            stats["pages_failed"]+=1
            print(json.dumps({"event":"fl_roster_listing_error","page":page,
                 "error":str(e)[:140]}),flush=True)
            continue
        for uri,attorneys in found["candidates"]:
            stats["new_frontier"]+=int(db.conn.execute(
                """INSERT OR IGNORE INTO fl_roster_frontier
                   (url,listed_attorneys,discovered_at) VALUES (?,?,?)""",
                (uri,attorneys,utc_now())).rowcount>0)
        db.conn.execute("INSERT OR REPLACE INTO fl_roster_pages VALUES (?,?,?,?)",
            (page,utc_now(),found["all_profiles"],len(found["candidates"])))
        db.conn.commit()
        stats["pages_fetched"]+=1
        stats["profiles_seen"]+=found["all_profiles"]
        stats["sized_2_to_10_listings"]+=len(found["candidates"])
        if polite_wait:time.sleep(polite_wait)
    return dict(stats)

def add_or_upgrade(db,lead):
    # A superior sourced firm count can replace a failed prior profile;
    # never erase existing website rejection or previously verified evidence.
    lead_id=db._id(lead)
    original=db.conn.execute(
        "SELECT status,source_url FROM candidates WHERE id=?",(lead_id,)).fetchone()
    if not original:
        return "added" if db.add(lead) else "already_known"
    if original["source_url"]==lead["source_url"]:
        return "already_known"
    if original["status"] not in ("unverified_size","unverified_identity","inconclusive"):
        return "preserved_other_status"
    db.conn.execute("""INSERT OR IGNORE INTO fl_roster_prior_sources
        VALUES (?,?,?,?)""",(lead_id,original["source_url"],original["status"],utc_now()))
    db.conn.execute("""UPDATE candidates SET source_url=?,status='pending',
        attempts=0,result_json='{}',updated=? WHERE id=?""",
        (lead["source_url"],utc_now(),lead_id))
    db.conn.commit()
    return "upgraded_source"

def verify_profiles(db,fetch_fn=fetch_public,max_profiles=300,seconds=260,
                    workers=5,polite_wait=0.35):
    ensure_tables(db)
    start=time.monotonic()
    rows=[dict(r) for r in db.conn.execute("""SELECT url,listed_attorneys
        FROM fl_roster_frontier WHERE status='pending' ORDER BY url LIMIT ?""",
        (max_profiles,)).fetchall()]
    def one(row):
        try:
            html=fetch_fn(row["url"],timeout=10)
            lead,status=parse_roster_profile(html,row["url"])
            if lead and lead["published_active_attorneys"]!=row["listed_attorneys"]:
                return row["url"],None,"listing_profile_count_mismatch"
            return row["url"],lead,status
        except Exception as exc:
            return row["url"],None,"network_"+type(exc).__name__
        finally:
            if polite_wait:time.sleep(polite_wait)
    stats=Counter()
    with ThreadPoolExecutor(max_workers=max(1,min(8,workers))) as pool:
        futures=[pool.submit(one,x) for x in rows]
        for future in as_completed(futures):
            url,lead,status=future.result()
            stats["profiles_attempted"]+=1
            stats[status]+=1
            if lead:
                stats["published_firm_size_phone"]+=1
                outcome=add_or_upgrade(db,lead)
                stats[outcome]+=1
            db.conn.execute("""UPDATE fl_roster_frontier
                SET checked_at=?,status=? WHERE url=?""",
                (utc_now(),status,url))
            db.conn.commit()
    return dict(stats)

def run(db_path,max_pages=156,max_profiles=300,seconds=440,fetch_fn=fetch_public):
    db=SqliteQueue(db_path)
    try:
        ensure_tables(db)
        if not robots_permits(fetch_fn):
            return {"status":"robots_not_permitted","counts":db.counts()}
        a=discover_listings(db,fetch_fn=fetch_fn,max_pages=max_pages,
                            seconds=min(seconds//3,150))
        b=verify_profiles(db,fetch_fn=fetch_fn,max_profiles=max_profiles,
                          seconds=max(1,seconds-150))
        remaining=db.conn.execute(
            "SELECT COUNT(*) FROM fl_roster_frontier WHERE status='pending'").fetchone()[0]
        return {"fl_roster_listings":a,"fl_roster_profiles":b,
            "frontier_remaining":remaining,"counts":db.counts(),
            "warning":"Headcount/phone source only. No site absence or usable email verified."}
    finally:db.close()

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--db",default="state/law-leads.sqlite3")
    p.add_argument("--max-pages",type=int,default=156)
    p.add_argument("--max-profiles",type=int,default=300)
    p.add_argument("--seconds",type=int,default=440)
    args=p.parse_args()
    print(json.dumps(run(args.db,args.max_pages,args.max_profiles,args.seconds)),flush=True)
if __name__=="__main__":
    main()
