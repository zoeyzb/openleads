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


def profile_rejection_reason(html):
    """Explain evidence gaps without inventing an attorney count.

    This is acquisition telemetry, not a qualification shortcut. The strict
    worker still independently verifies identity, firm size and owned site.
    """
    text=" ".join(reader(html).parts)
    m=re.search(r"\bFirm\s+Size\s*:?\s*(\d{1,2})\s*(?:[-–]\s*(\d{1,2}))?",text,re.I)
    if not m:
        return "no_explicit_firm_size"
    lo=int(m.group(1))
    hi=int(m.group(2) or lo)
    if lo<2:
        return "range_includes_one" if hi>lo else "one_attorney"
    if hi>10 or hi<lo:
        return "range_over_ten_or_invalid"
    # Size is firm-specific, but the firm contact number may be missing.
    if not re.search(r"\bCall\s+(?:\+?1[ .()-]*)?\(?[2-9]\d{2}\)?[ .()-]*[2-9]\d{2}[ .-]*\d{4}",text,re.I):
        return "eligible_size_but_no_published_call_phone"
    return "size_and_phone_present_parser_or_scope_miss"

def crawl_direct(db, fetch_fn=None, seconds=80, max_pages=36, delay=0.65):
    """Seek public profiles via state->city listings, plus explicit profile URLs.

    Every successfully visited URL has a durable checkpoint, including pages
    with no matching links. HTTP failures remain retryable. No page is
    classified as evidence of 'no owned website' here.
    """
    fetch_fn=fetch_fn or fetch_public
    db.conn.executescript("""CREATE TABLE IF NOT EXISTS direct_pages (
        url TEXT PRIMARY KEY, fetched_at TEXT NOT NULL,
        page_kind TEXT NOT NULL, links_found INTEGER NOT NULL,
        candidates_added INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS direct_frontier (
        url TEXT PRIMARY KEY, kind TEXT NOT NULL,
        state TEXT NOT NULL, discovered_at TEXT NOT NULL
    );""")
    # V1 saved visited city pages but discarded their discovered firm links.
    # One-time checkpoint migration reopens ONLY those directory indexes.
    # Previously verified/pending firms are not touched.
    if not db.conn.execute("SELECT 1 FROM direct_frontier LIMIT 1").fetchone():
        db.conn.execute("DELETE FROM direct_pages WHERE page_kind IN ('state','city')")
    seeds=[(url,"firm",state) for url,state in DIRECT_PROFILE_SEEDS]
    seeds += [(f"https://www.lawyer.com/{name}-lawyer.htm","state",state)
              for name,state in STATES]
    for url,kind,state in seeds:
        db.conn.execute("INSERT OR IGNORE INTO direct_frontier VALUES (?,?,?,?)",
                        (url,kind,state,utc_now()))
    db.conn.commit()
    results={"fetched":0,"failed":0,"profiles_fetched":0,
             "profiles_parsed":0,"candidates_added":0,"city_links":0,"firm_links":0,
             "profile_rejection_reasons":{}}
    deadline=time.monotonic()+max(1,int(seconds))
    failed_this_run=set()
    while (results["fetched"]+results["failed"]<max_pages
           and time.monotonic()<deadline):
        # Firm URLs are the scarce, highest-value work. State indexes come
        # next, county/city indexes last; the persisted frontier resumes
        # across ALL runs, including failure-status acquisition runs.
        pending=db.conn.execute("""SELECT f.url,f.kind,f.state FROM direct_frontier f
            LEFT JOIN direct_pages p ON p.url=f.url WHERE p.url IS NULL
            ORDER BY CASE f.kind WHEN 'firm' THEN 0 WHEN 'state' THEN 1 ELSE 2 END,
                     f.rowid ASC LIMIT 600""").fetchall()
        record=next((row for row in pending if row["url"] not in failed_this_run),None)
        if record is None:
            break
        url,kind,state=record["url"],record["kind"],record["state"]
        try:
            html=fetch_fn(url,timeout=9)
            if len(html)<150:
                raise ValueError("short/invalid page")
            results["fetched"]+=1
        except Exception as exc:
            failed_this_run.add(url)
            results["failed"]+=1
            print(json.dumps({"event":"direct_source_unavailable","url":url,
                              "reason":str(exc)[:150]}),flush=True)
            continue
        added=0
        discovered=0
        if kind=="firm":
            results["profiles_fetched"]+=1
            lead=_extract_directory_profile(url,html)
            if not lead:
                reason=profile_rejection_reason(html)
                reasons=results["profile_rejection_reasons"]
                reasons[reason]=reasons.get(reason,0)+1
                if reasons[reason]<=3:
                    print(json.dumps({"event":"directory_profile_rejected",
                                      "reason":reason,"source_url":url}),flush=True)
            if lead:
                results["profiles_parsed"]+=1
                lead["state"]=state
                if db.add(lead):
                    added=1
                    results["candidates_added"]+=1
        else:
            # Bound directory breadth without exhausting budget in one state.
            city_count=db.conn.execute(
                "SELECT COUNT(*) FROM direct_frontier WHERE kind='city' AND state=?",
                (state,)).fetchone()[0]
            for href,label in reader(html).links:
                child,ctype=source_url(href,url,state)
                if not child or (kind=="city" and ctype=="city"):
                    continue
                if ctype=="city" and city_count>=10:
                    continue
                inserted=db.conn.execute(
                    "INSERT OR IGNORE INTO direct_frontier VALUES (?,?,?,?)",
                    (child,ctype,state,utc_now())).rowcount
                if inserted:
                    discovered+=1
                    results["firm_links" if ctype=="firm" else "city_links"]+=1
                    if ctype=="city":
                        city_count+=1
        db.conn.execute(
            "INSERT OR IGNORE INTO direct_pages VALUES (?,?,?,?,?)",
            (url,utc_now(),kind,discovered,added))
        db.conn.commit()
        print(json.dumps({"event":"direct_source","url":url,"kind":kind,
                          "links_found":discovered,"added":added}),flush=True)
        if delay:
            time.sleep(delay)
    results["queued_remaining"]=db.conn.execute(
        """SELECT COUNT(*) FROM direct_frontier f
           LEFT JOIN direct_pages p ON p.url=f.url WHERE p.url IS NULL"""
    ).fetchone()[0]
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
