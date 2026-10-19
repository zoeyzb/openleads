"""Public Wisconsin local bar officer contacts, exact-card evidence only.

The authoritative page publishes named officers, private-practice employer,
office phone, email, and an active term in the same card. Source contacts are
research candidates, NOT proof of an absent owned website.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
from datetime import date, datetime
from html import unescape
from urllib.robotparser import RobotFileParser
from law_local.worker import (EMAIL_RE, SqliteQueue, USER_AGENT,
                              clearly_non_private_practice, fetch_public,
                              norm, normalize_phone, reader, utc_now)

URL="https://www.wisbar.org/Directories/LawRelatedOrgs/pages/wi-local-bars.aspx"
ROBOTS="https://www.wisbar.org/robots.txt"
CARDS=re.compile(r'(?is)<div class=["\']Item col-12 col-md-6["\']>(.*?)(?=<div class=["\']Item col-12 col-md-6["\']>|</div></div></p></div>|$)')

def plain(value):
    return " ".join(" ".join(reader(unescape(value)).parts).split())

def field(block,key):
    match=re.search(r"<li\b[^>]*class=['\"]"+re.escape(key)+r"['\"][^>]*>(.*?)</li>",block,re.I|re.S)
    return match.group(1) if match else ""

def _current_term(term,clock):
    m=re.search(r"(\d{1,2}/\d{1,2}/\d{4})\s*-\s*(\d{1,2}/\d{1,2}/\d{4})",term)
    if not m:return False
    try:
        start=datetime.strptime(m.group(1),"%m/%d/%Y").date()
        end=datetime.strptime(m.group(2),"%m/%d/%Y").date()
        return start<=clock<=end
    except ValueError:return False

def _private_name(name):
    if clearly_non_private_practice(name):return False
    # Local bar officers can work for corporations or public offices. Only
    # explicit private-law-practice names are admitted to the research queue.
    return bool(re.search(r"(?i)\b(?:law|legal|attorney|attorneys|lawyers|"
                          r"llp|pllc|aplc|p\.?c\.?|s\.?c\.?)\b",name))

def parse_cards(page,clock=None):
    clock=clock or date.today()
    found={}
    for m in CARDS.finditer(page):
        raw=m.group(1)
        person=plain(field(raw,"Name"))
        firm=plain(field(raw,"Company"))
        telephone=normalize_phone(plain(field(raw,"Phone")))
        email_raw=field(raw,"Email")
        mailto=re.search(r"(?i)mailto:([^\s'\"?#<>]+)",email_raw)
        email=unescape(mailto.group(1)).lower().strip() if mailto else ""
        shown=plain(email_raw).lower()
        if (not person.lower().startswith("atty.") or not firm
            or not telephone or not EMAIL_RE.fullmatch(email)
            or email not in shown
            or not _private_name(firm)
            or not _current_term(plain(field(raw,"Term")),clock)):
            continue
        location=plain(field(raw,"CityStateZip"))
        city=location.split(", WI",1)[0] if ", WI " in location else ""
        if not city:continue
        key=(norm(firm),telephone,email)
        found.setdefault(key,dict(firm=firm,phone=telephone,
            city=city,state="WI",email=email,person=person,
            term=plain(field(raw,"Term")),source_url=URL))
    return list(found.values())

def scoped_contact(page,firm,phone,clock=None):
    members=[x for x in parse_cards(page,clock) if norm(x["firm"])==norm(firm)
             and x["phone"]==normalize_phone(phone)]
    if not members:return None
    return dict(attorneys=0,attorney_range=None,
                emails=sorted({m["email"] for m in members}),
                website_candidates=[],scoped_contact_matched=True)

def ingest(queue,fetch=fetch_public,clock=None):
    clock=clock or date.today()
    report=dict(source_rows=0,candidates_added=0,qualified_created=0)
    queue.conn.execute("""CREATE TABLE IF NOT EXISTS wisbar_roster_fetches(
        source_url TEXT PRIMARY KEY, checked_date TEXT NOT NULL,
        checked_at TEXT NOT NULL, source_digest TEXT NOT NULL)""")
    prior=queue.conn.execute("SELECT checked_date FROM wisbar_roster_fetches WHERE source_url=?",
                             (URL,)).fetchone()
    if prior and prior[0]==clock.isoformat():
        return dict(report,reason="daily_source_cooldown")
    try:
        policy=fetch(ROBOTS,timeout=12)
        robot=RobotFileParser()
        robot.parse(policy.splitlines())
        if not robot.can_fetch(USER_AGENT,URL):
            return dict(report,reason="robots_disallowed")
        page=fetch(URL,timeout=12)
        rows=parse_cards(page,clock)
        if not rows:return dict(report,reason="no_scoped_public_contacts")
    except (OSError,ValueError,TimeoutError) as exc:
        return dict(report,reason="source_unavailable",error=type(exc).__name__)
    queue.conn.execute("""CREATE TABLE IF NOT EXISTS wisbar_contact_evidence (
        firm TEXT NOT NULL,phone TEXT NOT NULL,email TEXT NOT NULL,
        source_url TEXT NOT NULL,person TEXT NOT NULL,term TEXT NOT NULL,
        observed_at TEXT NOT NULL,source_digest TEXT NOT NULL,
        PRIMARY KEY(firm,phone,email))""")
    for record in rows:
        lead={k:record[k] for k in ("firm","phone","city","state","source_url")}
        report["candidates_added"]+=int(queue.add(lead))
        queue.conn.execute("""INSERT OR REPLACE INTO wisbar_contact_evidence
            VALUES(?,?,?,?,?,?,?,?)""",(record["firm"],record["phone"],record["email"],
            URL,record["person"],record["term"],utc_now(),
            hashlib.sha256(page.encode()).hexdigest()))
    queue.conn.execute("""INSERT OR REPLACE INTO wisbar_roster_fetches
        VALUES(?,?,?,?)""",(URL,clock.isoformat(),utc_now(),
                             hashlib.sha256(page.encode()).hexdigest()))
    queue.conn.commit()
    report["source_rows"]=len(rows)
    return report

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--db",default=str(__import__("pathlib").Path.home()/"lead-workspace/law-leads.sqlite3"))
    a=p.parse_args()
    queue=SqliteQueue(a.db)
    try:print(json.dumps({"wisbar_public_contacts":ingest(queue)}))
    finally:queue.close()

if __name__=="__main__":main()
