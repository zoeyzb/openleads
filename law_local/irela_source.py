"""Public IRELA attorney profiles: typed contacts, cached proof, polite discovery.

Only search-returned public profile URLs are used; no member-ID enumeration.
Profiles remain unqualified until the canonical source and website checks pass.
"""
import argparse
import hashlib
import json
import re
import sqlite3
import time
from pathlib import Path
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser
from law_local.worker import EMAIL_RE, USER_AGENT, SqliteQueue, fetch_public, norm, normalize_phone, reader, utc_now

ROOT = Path.home() / 'lead-workspace'
DB = ROOT / 'law-leads.sqlite3'
ROBOTS = 'https://irela.org/robots.txt'


def permitted(url):
    p = urlparse(url)
    return (p.scheme == 'https' and p.netloc in ('irela.org', 'www.irela.org')
            and re.fullmatch(r'/Sys/PublicProfile/\d+', p.path) is not None
            and not p.query and not p.fragment)


def fields(page):
    # Wild Apricot renders one label/body pair per field. Linked-member tables
    # and site footers have no such pairs and cannot donate email addresses.
    pairs = re.findall(r'''(?is)<div\b[^>]*class=["'][^"']*\bfieldLabel\b[^"']*["'][^>]*>(.*?)</div>\s*<div\b[^>]*class=["'][^"']*\bfieldBody\b[^"']*["'][^>]*>(.*?)</div>''', page)
    out = {}
    for label, body in pairs:
        key = ' '.join(' '.join(reader(label).parts).split())
        if key and key not in out:
            out[key] = body
    return out


def contact(url, page):
    if not permitted(url): return None, 'untrusted_source'
    data = fields(page)
    text = lambda key: ' '.join(' '.join(reader(data.get(key, '')).parts).split())
    level = text('Membership level')
    if not level.startswith('Attorney Member') or re.search('retired|inactive|sponsor', level, re.I):
        return None, 'not_current_attorney_member'
    firm = text('Firm')
    from law_local.florida_roster import clearly_non_law_employer, NON_PRIVATE
    person = norm(text('First Name') + ' ' + text('Last Name'))
    if (not firm or clearly_non_law_employer(firm) or NON_PRIVATE.search(firm)
            or not (re.search(r'\b(law|legal|attorney|attorneys)\b', firm, re.I)
                    or (person and person == norm(firm)))):
        return None, 'not_private_law_practice'
    zipcode = text('ZIP')
    if not re.fullmatch(r'6(?:0\d|1\d|2[0-9])\d{2}(?:-\d{4})?', zipcode):
        return None, 'not_illinois_contact'
    phone = normalize_phone(text('Phone'))
    emails = sorted(set(e.lower() for e in EMAIL_RE.findall(text('Email'))))
    if not phone or len(emails) != 1: return None, 'missing_scoped_contact'
    website = text('Website')
    links = [u for u, _ in reader(data.get('Website', '')).links if urlparse(u).scheme in ('http', 'https')]
    if website and '@' not in website:
        links.append(website if '://' in website else 'https://' + website)
    return dict(firm=firm,phone=phone,state='IL',city='',source_url=url,
                emails=emails,website_candidates=sorted(set(links))), 'candidate'


def fetch_profile(url, db=DB, fetch=None, clock=time.time):
    """Shared SQLite reservation enforces at least one minute per host request.

    Cache source HTML with a digest; failed HTTP requests also consume the rate
    slot. A robots outage or disallow blocks profile fetching, never bypasses it.
    """
    if not permitted(url): raise ValueError('Untrusted IRELA profile')
    fetch = fetch or fetch_public
    with sqlite3.connect(db, timeout=20) as con:
        con.executescript('''CREATE TABLE IF NOT EXISTS irela_source_cache
            (url TEXT PRIMARY KEY, html TEXT NOT NULL, sha256 TEXT NOT NULL, fetched REAL NOT NULL);
            CREATE TABLE IF NOT EXISTS irela_rate_limit (host TEXT PRIMARY KEY, attempted REAL NOT NULL);''')
        def cached(target):
            row=con.execute('SELECT html,fetched FROM irela_source_cache WHERE url=?',(target,)).fetchone()
            return row[0] if row and 0 <= clock()-row[1] < 86400 else None
        def request(target, delay):
            con.execute('BEGIN IMMEDIATE')
            last=con.execute('SELECT attempted FROM irela_rate_limit WHERE host=?',('irela.org',)).fetchone()
            if last and clock()-last[0] < delay:
                con.rollback();raise OSError('IRELA source deferred by shared crawl rate')
            con.execute('INSERT OR REPLACE INTO irela_rate_limit VALUES (?,?)',('irela.org',clock()));con.commit()
            html=fetch(target,timeout=9)
            con.execute('INSERT OR REPLACE INTO irela_source_cache VALUES (?,?,?,?)',
                        (target,html,hashlib.sha256(html.encode()).hexdigest(),clock()));con.commit()
            return html
        policy = cached(ROBOTS)
        if policy is None: policy = request(ROBOTS, 60)
        robot = RobotFileParser();robot.parse(policy.splitlines())
        if not robot.can_fetch(USER_AGENT,url): raise OSError('IRELA robots policy blocks profile')
        rate=robot.request_rate(USER_AGENT)
        delay=max(60,robot.crawl_delay(USER_AGENT) or 0,rate.seconds/rate.requests if rate else 0)
        html=cached(url)
        return html if html is not None else request(url,delay)


def discover(db, max_profiles=1):
    from law_local.free_search import searx_engine, SITE_ENGINES
    db.conn.execute('CREATE TABLE IF NOT EXISTS irela_frontier (url TEXT PRIMARY KEY,status TEXT NOT NULL,updated TEXT NOT NULL)')
    output=dict(profiles_fetched=0,candidates_added=0,deferred=0,source_failures=0,qualified_created=0)
    for mailbox in ('gmail.com','aol.com','comcast.net'):
        result=searx_engine('site:irela.org/Sys/PublicProfile "'+mailbox+'"',SITE_ENGINES[0])
        for url in result.get('urls',[]):
            if permitted(url): db.conn.execute('INSERT OR IGNORE INTO irela_frontier VALUES (?,?,?)',(url,'pending',utc_now()))
    db.conn.commit()
    path=db.conn.execute('PRAGMA database_list').fetchone()[2]
    for row in db.conn.execute("SELECT url FROM irela_frontier WHERE status='pending' ORDER BY url LIMIT ?",(max_profiles,)).fetchall():
        try:
            html=fetch_profile(row[0],path);lead,reason=contact(row[0],html)
            output['profiles_fetched']+=1
            if lead: output['candidates_added']+=int(db.add({k:v for k,v in lead.items() if k not in ('emails','website_candidates')}))
            db.conn.execute('UPDATE irela_frontier SET status=?,updated=? WHERE url=?',(reason,utc_now(),row[0]));db.conn.commit()
        except OSError as exc:
            if 'deferred' in str(exc):output['deferred']+=1
            else:output['source_failures']+=1
            break
    return output

if __name__ == '__main__':
    p=argparse.ArgumentParser();p.add_argument('--db',default=str(DB));a=p.parse_args();q=SqliteQueue(a.db)
    try:print(json.dumps({'irela_public_contacts':discover(q)}))
    finally:q.close()
