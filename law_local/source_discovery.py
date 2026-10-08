"""Direct, bounded public directory acquisition, independent of search-engine indexing.

These records are CANDIDATES only. The worker's source/size/site verification
must pass before any record is released to a calling list.
"""
from __future__ import annotations

import argparse
import json
import re
import time
from urllib.parse import urljoin, urlparse
from law_local.worker import (
    SqliteQueue, _extract_directory_profile, fetch_public, reader, utc_now,
)

# Small factual smoke-test seed from published directory pages, NOT qualified leads.
# Direct source URLs avoid falsely interpreting zero search hits as zero firms.
DIRECT_PROFILE_SEEDS = (
    ("https://www.lawyer.com/firm/cox-stauffer.html", "GA"),
    ("https://www.lawyer.com/firm/holt-law-firm-la.html", "LA"),
    ("https://www.lawyer.com/firm/tyler-and-maderer-pllc-tx.html", "TX"),
    ("https://www.lawyer.com/firm/acker-warren-pc.html", "TX"),
    ("https://www.lawyer.com/firm/nn_legal_group-il.html", "IL"),
    ("https://www.lawyer.com/firm/dubois-law-group.html", "FL"),
    ("https://www.lawyer.com/firm/borrell-and-riso-llp.html", "NY"),
    ("https://www.lawyer.com/firm/the-socal-law-network.html", "CA"),
    ("https://www.lawyer.com/firm/law-office-of-arthur-hernandez.html", "FL"),
    ("https://www.lawyer.com/firm/chadwick-tignor-p-c.html", "TN"),
    ("https://www.lawyer.com/firm/curtis-porter-adams-pllc-id.html", "ID"),
    ("https://www.lawyer.com/firm/cain-kiel-law.html", "TX"),
)

STATES = (
    ("florida", "FL"), ("texas", "TX"), ("illinois", "IL"),
    ("georgia", "GA"), ("ohio", "OH"),
)

def source_url(raw, base, state=None):
    """Only first-party public legal directory pages. Never follow external sites."""
    if not raw or raw.startswith(("#", "javascript:", "mailto:", "tel:")):
        return "", ""
    url=urljoin(base, raw)
    p=urlparse(url)
    host=(p.hostname or "").lower().removeprefix("www.")
    if p.scheme not in ("https", "http") or host!="lawyer.com":
        return "", ""
    path=p.path.lower()
    if path.startswith(("/firm/", "/firms/")) and path.endswith((".html", ".htm")):
        return url.split("#",1)[0], "firm"
    if state and re.search(r"-lawyer-"+re.escape(state.lower())+r"\.htm$",path):
        return url.split("#",1)[0], "city"
    return "", ""

def crawl_direct(db, fetch_fn=None, seconds=80, max_pages=36, delay=0.65):
    """Seek public profiles via state->city listings, plus explicit profile URLs.

    Every successfully visited URL has a durable checkpoint, including pages
    with no matching links. HTTP failures remain retryable. No page is
    classified as evidence of 'no owned website' here.
    """
    fetch_fn=fetch_fn or fetch_public
    db.conn.execute("""CREATE TABLE IF NOT EXISTS direct_pages (
        url TEXT PRIMARY KEY, fetched_at TEXT NOT NULL,
        page_kind TEXT NOT NULL, links_found INTEGER NOT NULL,
        candidates_added INTEGER NOT NULL
    )""")
    db.conn.commit()
    results={"fetched":0,"failed":0,"profiles_fetched":0,
             "profiles_parsed":0,"candidates_added":0,"city_links":0,"firm_links":0}
    deadline=time.monotonic()+max(1,int(seconds))
    queue=[(url,"firm",state) for url,state in DIRECT_PROFILE_SEEDS]
    queue += [(f"https://www.lawyer.com/{name}-lawyer.htm","state",code)
              for name,code in STATES]
    visited=set()
    while queue and results["fetched"]+results["failed"]<max_pages and time.monotonic()<deadline:
        url,kind,state=queue.pop(0)
        if url in visited:
            continue
        visited.add(url)
        if db.conn.execute("SELECT 1 FROM direct_pages WHERE url=?",(url,)).fetchone():
            continue
        try:
            html=fetch_fn(url,timeout=9)
            if len(html)<150:
                raise ValueError("short/invalid page")
            results["fetched"]+=1
        except Exception as exc:
            results["failed"]+=1
            print(json.dumps({"event":"direct_source_unavailable","url":url,"reason":str(exc)[:150]}),flush=True)
            continue
        added=0
        discovered=0
        if kind=="firm":
            results["profiles_fetched"]+=1
            lead=_extract_directory_profile(url,html)
            if lead:
                results["profiles_parsed"]+=1
                lead["state"]=state
                if db.add(lead):
                    added=1
                    results["candidates_added"]+=1
        else:
            for href,label in reader(html).links:
                child,ctype=source_url(href,url,state)
                if not child:
                    continue
                if kind=="city" and ctype=="city":
                    continue
                if ctype=="city" and results["city_links"]>=35:
                    continue
                if child not in visited:
                    queue.append((child,ctype,state))
                    discovered+=1
                    results["firm_links" if ctype=="firm" else "city_links"]+=1
        db.conn.execute(
            "INSERT OR IGNORE INTO direct_pages VALUES (?,?,?,?,?)",
            (url,utc_now(),kind,discovered,added))
        db.conn.commit()
        print(json.dumps({"event":"direct_source","url":url,"kind":kind,
                          "links_found":discovered,"added":added}),flush=True)
        if delay:
            time.sleep(delay)
    results["queued_remaining"]=len(queue)
    return results

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--db",default="state/law-leads.sqlite3")
    p.add_argument("--seconds",type=int,default=80)
    p.add_argument("--max-pages",type=int,default=36)
    args=p.parse_args()
    db=SqliteQueue(args.db)
    try:
        print(json.dumps({"direct_discovery":crawl_direct(
            db,seconds=args.seconds,max_pages=args.max_pages),
            "counts":db.counts()}))
    finally:
        db.close()

if __name__=="__main__":
    main()
