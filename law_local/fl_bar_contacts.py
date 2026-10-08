"""Conservative FL Bar published-email/owned-site research for already sourced firms.

Not a final eligibility decision. It records evidence independently while
website absence remains unverified. Public robots/permission checks precede
HTTP requests. Failed source requests are neither emails nor no-site evidence.
"""
from __future__ import annotations

import argparse
import json
import re
import time
from html import unescape
from pathlib import Path
from urllib import robotparser
from urllib.parse import urljoin,urlparse
from law_local.worker import (
    SqliteQueue,normalize_phone,norm,reader,fetch_public,
    domain_has_mail,utc_now,_third_party
)
from law_local.florida_roster import parse_roster_profile

BAR_ROOT="https://www.floridabar.org"
FLD_ROOT="https://www.floridalawdirectory.com"
ATTORNEY_LINK=re.compile(r'''href\s*=\s*["']([^"']*/attorney/[a-z0-9-]+-(\d{2,8})(?:/|[?#])?)["']''',re.I)
EMAIL=re.compile(r"(?i)\b[a-z0-9._%+\-]+@[a-z0-9.-]+\.[a-z]{2,}\b")
PHONE=re.compile(r"(?<!\d)(?:\+?1[\s.()\-]*)?\(?[2-9]\d{2}\)?[\s.()\-]*[2-9]\d{2}[\s.\-]*\d{4}(?!\d)")
FIRM_WEBSITE=re.compile(r"(?i)\bFirm\s+Website\s*:?\s*(https?://[a-z0-9.-]+(?:/[^\s]*)?)")
EMPTY_EMAIL_PREFIX=("noreply@","no-reply@","donotreply@","example@","test@")

def bar_profile_url(bar_number):
    digits=str(bar_number or "")
    if not re.fullmatch(r"\d{2,8}",digits):
        raise ValueError("Florida Bar number is not numeric")
    return BAR_ROOT+"/directories/find-mbr/profile/?num="+digits

def parse_roster_member_ids(html):
    """Only links under the active-attorney heading, never former members."""
    content=str(html or "")
    heading=re.search(r"(?i)\bActive\s+attorneys\s*\(\s*\d+\s*\)",content)
    if not heading:
        return []
    section=content[heading.end():]
    # Other named sections must not leak former/inactive attorney links.
    end=re.search(r"(?i)(?:<h[1-6][^>]*>\s*)?(?:Former|Inactive|Other.status)\b",section)
    if end:
        section=section[:end.start()]
    ids=[]
    for m in ATTORNEY_LINK.finditer(section):
        if m.group(2) not in ids:
            ids.append(m.group(2))
    return ids[:10]

def parse_bar_profile_contact(html,firm,phone,bar_number):
    """A published professional address must match the exact bar-record firm and office phone."""
    source=bar_profile_url(bar_number)
    result={"bar_number":str(bar_number),"email_source":source,
            "email":"","website":"","status":"identity_mismatch"}
    doc=reader(html)
    text=" ".join(doc.parts)
    name=norm(firm)
    office=re.search(r"(?i)\bOffice\s*:?\s*(.{0,100})",text)
    office_phones=PHONE.findall(office.group(1)) if office else []
    expected=normalize_phone(phone)
    exact_phone=bool(expected and expected in [normalize_phone(p) for p in office_phones])
    # Only accept a full named firm; do not match an acronym or common surname.
    if not name or len(name)<8 or name not in norm(text) or not exact_phone:
        return result
    result["status"]="no_published_contact"
    site=FIRM_WEBSITE.search(text)
    if site:
        url=site.group(1).rstrip('.,);>')
        if urlparse(url).hostname and not _third_party(urlparse(url).hostname or ""):
            result["website"]=url
            result["status"]="published_site"
    mail=[]
    for m in EMAIL.finditer(text):
        email=m.group(0).lower()
        if email.startswith(EMPTY_EMAIL_PREFIX) or _third_party(email.rsplit("@",1)[1]):
            continue
        # The email must appear in the Bar profile's labeled Email field.
        near=text[max(0,m.start()-85):m.start()]
        if re.search(r"(?i)\bEmail\s*:\s*$",near):
            mail.append(email)
    if mail:
        result["email"]=mail[0]
        result["status"]="published_site_and_email" if result["website"] else "published_mx_pending"
    return result

def ensure_table(db):
    db.conn.executescript("""
      CREATE TABLE IF NOT EXISTS fl_bar_contact_proofs (
        candidate_id TEXT NOT NULL,
        bar_number TEXT NOT NULL,
        firm TEXT NOT NULL,
        phone TEXT NOT NULL,
        email TEXT NOT NULL DEFAULT '',
        email_source TEXT NOT NULL,
        mx_ok INTEGER NOT NULL DEFAULT 0,
        website TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        PRIMARY KEY(candidate_id,bar_number)
      );
      CREATE INDEX IF NOT EXISTS fl_bar_contact_status
        ON fl_bar_contact_proofs(status,mx_ok);
      CREATE TABLE IF NOT EXISTS fl_bar_contact_attempts (
        candidate_id TEXT PRIMARY KEY,
        attempted_at TEXT NOT NULL,
        status TEXT NOT NULL
      );
    """)
    db.conn.commit()

def store_bar_contact_proof(db,lead,result,mx_ok=False):
    ensure_table(db)
    cid=db._id(lead)
    bar_id=result["bar_number"]
    source=bar_profile_url(bar_id)
    status=str(result.get("status") or "source_unavailable")
    email=result.get("email") or ""
    db.conn.execute("""INSERT OR REPLACE INTO fl_bar_contact_proofs
        (candidate_id,bar_number,firm,phone,email,email_source,mx_ok,
         website,status,checked_at) VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (cid,bar_id,lead["firm"],normalize_phone(lead["phone"]),
         email,source,int(bool(mx_ok and email)),result.get("website") or "",
         status,utc_now()))
    db.conn.commit()

def contact_proof_totals(db):
    ensure_table(db)
    p=db.conn
    return {
        "source_emails_with_mx":p.execute(
            "SELECT COUNT(DISTINCT candidate_id) FROM fl_bar_contact_proofs WHERE mx_ok=1 AND email<>''"
        ).fetchone()[0],
        "profiles_with_owned_website_signal":p.execute(
            "SELECT COUNT(DISTINCT candidate_id) FROM fl_bar_contact_proofs WHERE website<>''"
        ).fetchone()[0],
        "published_email_not_yet_mx_confirmed":p.execute(
            "SELECT COUNT(DISTINCT candidate_id) FROM fl_bar_contact_proofs WHERE email<>'' AND mx_ok=0"
        ).fetchone()[0],
        "firms_researched":p.execute(
            "SELECT COUNT(*) FROM fl_bar_contact_attempts WHERE status='completed'"
        ).fetchone()[0]
    }

def robots_allowed(fetch_fn=fetch_public):
    for root,paths in (
        (FLD_ROOT,["/firm/"]),
        (BAR_ROOT,["/directories/find-mbr/profile/?num=123456"])):
        try:
            raw=fetch_fn(root+"/robots.txt",timeout=10)
            p=robotparser.RobotFileParser()
            p.parse(raw.splitlines())
            if not all(p.can_fetch("OpenLeads-Law-Evidence",root+v) for v in paths):
                return False
        except Exception:
            return False
    return True

def collect(db,max_firms=20,max_members=2,seconds=90,fetch_fn=None,mailcheck=None):
    """Polite bounded pilot on public sources only, preserving every evidence level."""
    fetch_fn=fetch_fn or fetch_public
    mailcheck=mailcheck or domain_has_mail
    ensure_table(db)
    if not robots_allowed(fetch_fn):
        return {"status":"robots_unavailable_or_forbidden","processed":0,"strict_eligible_new":0}
    db.conn.row_factory=db.conn.row_factory
    rows=db.conn.execute("""SELECT c.id,c.firm,c.phone,c.city,c.state,c.source_url
       FROM candidates c LEFT JOIN fl_bar_contact_attempts a ON a.candidate_id=c.id
       WHERE c.source_url LIKE 'https://www.floridalawdirectory.com/firm/%'
        AND c.status NOT IN ('review_nonlaw_employer','owned_site_or_untrusted_source')
        AND a.candidate_id IS NULL
       ORDER BY c.id LIMIT ?""",(max(1,min(int(max_firms),200)),)).fetchall()
    limit=time.monotonic()+max(1,int(seconds))
    stats={"status":"completed","firms_attempted":0,"bar_profiles_fetched":0,
           "source_emails_with_mx_added":0,"owned_site_signals":0,
           "source_failures":0,"strict_eligible_new":0}
    for row in rows:
        if time.monotonic()>=limit:
            stats["deadline_reached"]=True
            break
        lead=dict(row)
        try:
            html=fetch_fn(lead["source_url"],timeout=10)
            if not parse_roster_profile(html,lead["source_url"])[0]:
                raise ValueError("Firm directory identity/size/phone source unavailable")
            members=parse_roster_member_ids(html)
            if not members:
                raise ValueError("No attributed active-member links")
            for bar_id in members[:max(1,min(3,int(max_members)))]:
                if time.monotonic()>=limit:
                    break
                source=bar_profile_url(bar_id)
                profile=fetch_fn(source,timeout=10)
                result=parse_bar_profile_contact(profile,lead["firm"],lead["phone"],bar_id)
                mx_ok=bool(result["email"] and mailcheck(result["email"].split("@",1)[1]))
                store_bar_contact_proof(db,lead,result,mx_ok)
                stats["bar_profiles_fetched"]+=1
                stats["source_emails_with_mx_added"]+=int(mx_ok)
                stats["owned_site_signals"]+=int(bool(result["website"]))
                time.sleep(0.3)
            db.conn.execute("INSERT OR REPLACE INTO fl_bar_contact_attempts VALUES (?,?,?)",
                            (lead["id"],utc_now(),"completed"))
            db.conn.commit()
            stats["firms_attempted"]+=1
        except Exception as err:
            stats["source_failures"]+=1
            print(json.dumps({"event":"fl_bar_contact_source_error",
                "firm":lead["firm"],"reason":str(err)[:120]}),flush=True)
            # An outage is NOT a completed negative lookup. Retry in a later pilot.
        time.sleep(0.4)
    stats["totals"]=contact_proof_totals(db)
    return stats

def main():
    parser=argparse.ArgumentParser(description="FL official member-email evidence pilot; never promotes eligibility")
    parser.add_argument("--db",default="state/law-leads.sqlite3")
    parser.add_argument("--max-firms",type=int,default=20)
    parser.add_argument("--max-members",type=int,default=2)
    parser.add_argument("--seconds",type=int,default=90)
    args=parser.parse_args()
    db=SqliteQueue(args.db)
    try:
        print(json.dumps({"fl_bar_contact_proof":collect(db,args.max_firms,args.max_members,args.seconds)}))
    finally:
        db.close()
if __name__=="__main__":
    main()
