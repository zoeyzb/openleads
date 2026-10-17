"""Public, source-scoped law-practice contacts from PLEA's state directories.

Source-attested email + phone + several members are valuable research inputs;
these do NOT establish total firm size, active bar status, or website absence.
No lead is placed in the verified calling queue by this adapter.
"""
from __future__ import annotations
import argparse, hashlib, html, json, re, sqlite3, time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse
from law_local.free_search import search_firm, valid_provider_pair
from law_local.site_provider_health import audit_provider_health
from law_local.worker import EMAIL_RE, classify_search_results, fetch_public, firm_identity_matches, normalize_phone, norm, reader, utc_now

ROOT=Path.home()/'lead-workspace'
STATES=tuple('''al ak az ar ca co ct de dc fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy'''.split())
SOURCE='plea.net'
MEMBER_CARD=re.compile(r'(?is)<div\s+class=["\']row attorney["\'][^>]*>(.*?)(?=<div\s+class=["\']row attorney["\']|</section>|\Z)')
H2=re.compile(r'(?is)<h2\b[^>]*>(.*?)</h2>')
H3=re.compile(r'(?is)<h3\b[^>]*>(.*?)</h3>')
POST_ID=re.compile(r'\bid=["\'](post_\d+)["\']')
PHONE=re.compile(r'(?is)Phone:\s*<a\s+href=["\']tel:([^"\']+)')
EMAIL=re.compile(r'(?is)Email:\s*<a\s+href=["\']mailto:([^"\']+)')
FILLER={'of','the','law','office','offices','firm','group','attorney','attorneys','and',
        'llc','pllc','llp','pa','pc','aplc','at'}

def plain(value):
    return ' '.join(html.unescape(re.sub(r'<[^>]+>',' ',value)).split())

def practice_key(firm):
    words=[w for w in norm(firm).split() if w not in FILLER]
    return ' '.join(words)

def parse_directory(page,state):
    """Trust only contacts inside one PLEA member card, never site footer."""
    if state.lower() not in STATES:raise ValueError('unsupported directory state')
    if 'class="row attorney"' not in page and "class='row attorney'" not in page:
        return []
    records=[]
    segment=page.split('class="hp-what"',1)[-1].split('</section>',1)[0]
    for match in MEMBER_CARD.finditer(segment):
        card=match.group(0)
        name=H2.search(card);firm=H3.search(card)
        phone=PHONE.search(card);mailbox=EMAIL.search(card)
        if not all((name,firm,phone,mailbox)):
            continue
        person=plain(name.group(1));organization=plain(firm.group(1))
        organization=re.sub(r'(?i)^of\s+','',organization).strip()
        office_phone=normalize_phone(phone.group(1))
        mail=html.unescape(mailbox.group(1)).strip().lower()
        anchor=POST_ID.search(match.group(0)[:240])
        address_city=re.search(r'(?is)<br\s*/?>\s*([A-Za-z][A-Za-z .\'-]{2,60}),\s*([A-Z]{2})\s*\d{5}(?:-\d{4})?',card)
        city=(plain(address_city.group(1)) if address_city and address_city.group(2).lower()==state.lower() else '')
        if (not person or len(person)<5 or not practice_key(organization)
            or len(practice_key(organization))<3 or not office_phone
            or not EMAIL_RE.fullmatch(mail) or mail.endswith('@plea.net')
            or not anchor):
            continue
        source=f'https://plea.net/attorneys/{state.lower()}/#{anchor.group(1)}'
        records.append(dict(person=person,firm=organization,phone=office_phone,
                            email=mail,state=state.upper(),city=city,source_url=source))
    return records

def group_contacts(people):
    groups={}; phones=defaultdict(set)
    for person in people:
        key=(practice_key(person['firm']),person['phone'])
        if key not in groups:
            groups[key]={'firm':person['firm'],'phone':person['phone'],
                         'states':set(),'cities':set(),'aliases':set(),'people':{}}
        grp=groups[key]
        grp['states'].add(person['state']);grp['aliases'].add(person['firm'])
        if person.get('city'):grp['cities'].add(person['city'])
        member=grp['people'].setdefault(norm(person['person']),dict(person=person['person'],email=person['email'],city=person.get('city',''),source_url=person['source_url']))
        # Keep original evidence, do not overwrite alternate membership email.
        phones[person['phone']].add(key)
    rows=[]
    for key,grp in groups.items():
        rid=hashlib.sha256(('plea|'+key[0]+'|'+key[1]).encode()).hexdigest()[:24]
        rows.append(dict(id=rid,firm=grp['firm'],phone=grp['phone'],
           member_count=len(grp['people']),members=sorted(grp['people'].values(),key=lambda m:m['person']),
           aliases=sorted(grp['aliases']),states=sorted(grp['states']),cities=sorted(grp['cities']),
           shared_phone_conflict=len(phones[grp['phone']])>1))
    return sorted(rows,key=lambda r:(-int(r['member_count']>=2),-r['member_count'],
                    -int('&' in r['firm'] or 'llp' in r['firm'].lower()),r['firm'],r['id']))

def ensure(conn):
    conn.executescript('''CREATE TABLE IF NOT EXISTS plea_source_pages(
       state TEXT PRIMARY KEY,checked_at TEXT NOT NULL,contacts INTEGER NOT NULL,
       status TEXT NOT NULL,error TEXT NOT NULL DEFAULT '');
       CREATE TABLE IF NOT EXISTS plea_firm_research(
       id TEXT PRIMARY KEY,firm TEXT NOT NULL,phone TEXT NOT NULL,member_count INTEGER NOT NULL,
       research_json TEXT NOT NULL,collected_at TEXT NOT NULL,
       website_status TEXT NOT NULL DEFAULT 'not_checked',
       website_checked_at TEXT NOT NULL DEFAULT '',website_evidence_json TEXT NOT NULL DEFAULT '{}');
       CREATE INDEX IF NOT EXISTS idx_plea_site_queue ON plea_firm_research(website_status,member_count);
       CREATE UNIQUE INDEX IF NOT EXISTS idx_plea_phone_canon ON plea_firm_research(id);
       CREATE TABLE IF NOT EXISTS plea_owned_site_audit_history(
           lead_id TEXT NOT NULL, checked_at TEXT NOT NULL,
           source_url TEXT NOT NULL, website_url TEXT NOT NULL,
           prior_status TEXT NOT NULL, prior_evidence_json TEXT NOT NULL,
           PRIMARY KEY(lead_id,source_url,website_url));''')
    conn.commit()

def ingest(catalog=ROOT/'research_catalog.sqlite3',states=STATES,fetch=fetch_public,age_hours=24):
    if any(s not in STATES for s in states):raise ValueError('unsupported state')
    db=sqlite3.connect(catalog,timeout=20);db.row_factory=sqlite3.Row
    now=datetime.now(timezone.utc)
    stats={'fetched_pages':0,'member_contacts_found':0,'new_firm_research':0,
           'updated_existing':0,'source_errors':0,'strict_qualified_created':0}
    try:
        ensure(db)
        collected=[]
        for state in states:
            last=db.execute('SELECT * FROM plea_source_pages WHERE state=?',(state,)).fetchone()
            if last is not None and last['status'] in ('ok','source_unavailable'):
                try:
                    age=now-datetime.fromisoformat(last['checked_at'])
                    if timedelta(0)<=age<timedelta(hours=age_hours):continue
                except (ValueError,TypeError):pass
            url=f'https://plea.net/attorneys/{state}/'
            try:
                page=fetch(url,timeout=12)
                parsed=parse_directory(page,state)
                if not parsed:raise ValueError('no-scoped-directory-contacts')
                collected.extend(parsed)
                db.execute('INSERT OR REPLACE INTO plea_source_pages VALUES(?,?,?,?,?)',
                           (state,utc_now(),len(parsed),'ok',''))
                stats['fetched_pages']+=1;stats['member_contacts_found']+=len(parsed)
            except Exception as exc:
                db.execute('INSERT OR REPLACE INTO plea_source_pages VALUES(?,?,?,?,?)',
                           (state,utc_now(),0,'source_unavailable',type(exc).__name__))
                stats['source_errors']+=1
            db.commit()
        # Combine with already persisted source members, retaining prior phones
        # and evidence from state pages not due for re-fetch this run.
        for row in db.execute('SELECT research_json FROM plea_firm_research'):
            try:
                old=json.loads(row['research_json'])
                for m in old['members']:
                    parsed=urlparse(m['source_url'])
                    parts=parsed.path.split('/')
                    state=parts[2]
                    if state in STATES:
                        collected.append(dict(person=m['person'],firm=old['firm'],
                                    phone=old['phone'],email=m['email'],state=state.upper(),
                                    city=m.get('city') or (old.get('cities',[''])[0] if len(old.get('cities',[]))==1 else ''),
                                    source_url=m['source_url']))
            except (ValueError,TypeError,KeyError,IndexError):continue
        for row in group_contacts(collected):
            serialized=json.dumps(row,sort_keys=True)
            old=db.execute('SELECT research_json FROM plea_firm_research WHERE id=?',(row['id'],)).fetchone()
            if old is None:
                db.execute('''INSERT INTO plea_firm_research
                    (id,firm,phone,member_count,research_json,collected_at)
                    VALUES(?,?,?,?,?,?)''',(row['id'],row['firm'],row['phone'],row['member_count'],serialized,utc_now()))
                stats['new_firm_research']+=1
            elif old[0]!=serialized:
                db.execute('''UPDATE plea_firm_research SET member_count=?,research_json=?,collected_at=?
                    WHERE id=?''',(row['member_count'],serialized,utc_now(),row['id']))
                stats['updated_existing']+=1
        db.commit()
        stats['total_firms']=db.execute('SELECT COUNT(*) FROM plea_firm_research').fetchone()[0]
        stats['two_or_more_listed_members']=db.execute('SELECT COUNT(*) FROM plea_firm_research WHERE member_count>=2').fetchone()[0]
        return stats
    finally:db.close()

def audit_sites(catalog=ROOT/'research_catalog.sqlite3',limit=8,search=search_firm,health=None):
    limit=int(limit)
    if not 1<=limit<=12:raise ValueError('max must be 1..12')
    check=health if health is not None else lambda: audit_provider_health(lookups=search)
    provider=check()
    result={'attempted':0,'possible_owned_sites':0,'no_attributable_site_found':0,
            'inconclusive':0,'strict_qualified_created':0,'provider_health':provider.get('status')}
    if provider.get('status')!='usable' or not provider.get('positive_control_found'):
        return dict(result,reason='positive_owned_site_control_failed')
    db=sqlite3.connect(catalog,timeout=20);db.row_factory=sqlite3.Row
    try:
        ensure(db)
        due=(datetime.now(timezone.utc)-timedelta(hours=6)).isoformat(timespec='seconds')
        rows=db.execute('''SELECT * FROM plea_firm_research
            WHERE (website_status='not_checked' OR
                   (website_status='inconclusive' AND website_checked_at<?))
              AND (member_count>=2 OR firm LIKE '%&%' OR lower(firm) LIKE '% llp%'
                   OR lower(firm) LIKE '% law group%')
            ORDER BY CASE
                 WHEN (lower(research_json) LIKE '%@gmail.com%'
                       OR lower(research_json) LIKE '%@yahoo.com%'
                       OR lower(research_json) LIKE '%@aol.com%'
                       OR lower(research_json) LIKE '%@outlook.com%')
                     AND member_count>=2 THEN 0
                 WHEN member_count>=2 THEN 1
                 WHEN (lower(research_json) LIKE '%@gmail.com%'
                       OR lower(research_json) LIKE '%@yahoo.com%'
                       OR lower(research_json) LIKE '%@aol.com%'
                       OR lower(research_json) LIKE '%@outlook.com%') THEN 2
                 ELSE 3 END,
                 member_count DESC,firm,id LIMIT ?''',(due,limit)).fetchall()
        for record in rows:
            research=json.loads(record['research_json'])
            city=research.get('cities',[''])[0] if len(research.get('cities',[]))==1 else ''
            # Never fabricate a location or select one arbitrarily across offices.
            state=research['states'][0] if len(research['states'])==1 else ''
            lead={'firm':record['firm'],'phone':record['phone'],'state':state,'city':city}
            try:
                sources=search(lead)
                if not valid_provider_pair(sources):
                    raise ValueError('incorrect-search-provider-attribution')
                verdict=classify_search_results(sources)
                website_status=verdict['status']
                evidence={'providers':sources[:2],'verdict':verdict,'checked_at':utc_now(),
                          'disclaimer':'site research only; firmwide size not verified'}
            except (ValueError,TypeError,KeyError,OSError) as exc:
                website_status='inconclusive'
                evidence={'error':type(exc).__name__,'checked_at':utc_now()}
            db.execute('''UPDATE plea_firm_research
                SET website_status=?,website_checked_at=?,website_evidence_json=? WHERE id=?''',
                (website_status,utc_now(),json.dumps(evidence,sort_keys=True),record['id']))
            db.commit()
            result['attempted']+=1
            if website_status=='review_website':result['possible_owned_sites']+=1
            elif website_status=='screened_no_site':result['no_attributable_site_found']+=1
            else:result['inconclusive']+=1
        return result
    finally:db.close()

def confirm_explicit_owned_site(catalog,lead_id,source_url,fetch=fetch_public):
    """Hold a source-verified firm when a directory explicitly links to its site.

    Positive-only evidence; source absence or failure never clears websites.
    """
    parsed=urlparse(source_url)
    host=(parsed.hostname or '').lower().removeprefix('www.')
    if (parsed.scheme!='https' or host not in ('lawyers.findlaw.com','lawinfo.com')
            or not parsed.path or parsed.query or parsed.fragment or parsed.port not in (None,443)):
        return {'confirmed':0,'reason':'untrusted_directory_source'}
    db=sqlite3.connect(catalog,timeout=20)
    db.row_factory=sqlite3.Row
    try:
        ensure(db)
        firm=db.execute('SELECT * FROM plea_firm_research WHERE id=?',(lead_id,)).fetchone()
        if firm is None:return {'confirmed':0,'reason':'firm_not_found'}
        try:
            page=fetch(source_url,timeout=12)
        except Exception as exc:
            return {'confirmed':0,'reason':'source_unavailable','error':type(exc).__name__}
        if not firm_identity_matches(page,{'firm':firm['firm'],'phone':firm['phone']}):
            return {'confirmed':0,'reason':'source_firm_phone_mismatch'}
        candidates=[]
        for url,label in reader(page).links:
            label=norm(label)
            if label not in ('website','visit website','firm website','visit site','official website'):
                continue
            target=urlparse(url)
            website_host=(target.hostname or '').lower().removeprefix('www.')
            if (target.scheme not in ('https','http') or not website_host or
                    target.username or target.password or website_host==host or
                    website_host.endswith('.'+host)):
                continue
            candidates.append(url)
        # Multiple distinct labeled sites require explicit attribution review.
        unique=sorted(set(candidates))
        if len(unique)!=1:
            return {'confirmed':0,'reason':'no_single_attributable_website','candidates':len(unique)}
        site=unique[0]
        old=firm['website_status']
        try:previous=json.loads(firm['website_evidence_json'] or '{}')
        except (ValueError,TypeError):previous={}
        record={'firm':firm['firm'],'phone':firm['phone'], 'site_url':site,
                'source_url':source_url,'verified_at':utc_now(),
                'evidence':'directory explicit Website link and matching firm + phone',
                'prior_website_status':old,'prior_website_evidence':previous}
        c=db.execute('''INSERT OR IGNORE INTO plea_owned_site_audit_history
            (lead_id,checked_at,source_url,website_url,prior_status,prior_evidence_json)
            VALUES(?,?,?,?,?,?)''',(lead_id,record['verified_at'],source_url,site,
                                     old,json.dumps(previous,sort_keys=True)))
        if c.rowcount==0:
            return {'confirmed':1,'new_evidence':0,'status':'published_owned_website','site':site}
        db.execute('''UPDATE plea_firm_research SET website_status=?,website_checked_at=?,website_evidence_json=?
            WHERE id=?''',('published_owned_website',record['verified_at'],
                           json.dumps(record,sort_keys=True),lead_id))
        db.execute('''CREATE TABLE IF NOT EXISTS external_evidence (
             lead_id TEXT NOT NULL,kind TEXT NOT NULL,proof_url TEXT NOT NULL,
             note TEXT NOT NULL,verified_at TEXT NOT NULL,
             PRIMARY KEY(lead_id,kind,proof_url))''')
        db.execute('''INSERT OR IGNORE INTO external_evidence(lead_id,kind,proof_url,note,verified_at)
             VALUES(?,?,?,?,?)''',('plea:'+lead_id,'owned_website',site,
                    json.dumps({'directory':source_url,'firm':firm['firm'],'phone':firm['phone'],
                                'matched_source':True},sort_keys=True),record['verified_at']))
        db.commit()
        return {'confirmed':1,'new_evidence':1,'status':'published_owned_website',
                'site':site,'firm':firm['firm']}
    finally:db.close()


def main():
    p=argparse.ArgumentParser(description='Public attorney+published business email discovery; NO qualification')
    sub=p.add_subparsers(dest='cmd',required=True)
    ingest_p=sub.add_parser('ingest');ingest_p.add_argument('--states',default=','.join(STATES))
    sites=sub.add_parser('audit-sites');sites.add_argument('--max',type=int,default=8)
    owned=sub.add_parser('confirm-owned-site')
    owned.add_argument('--lead-id',required=True)
    owned.add_argument('--source-url',required=True)
    args=p.parse_args()
    if args.cmd=='ingest':
        result=ingest(states=[x.strip().lower() for x in args.states.split(',') if x.strip()])
    elif args.cmd=='audit-sites':
        result=audit_sites(limit=args.max)
    else:
        result=confirm_explicit_owned_site(ROOT/'research_catalog.sqlite3',args.lead_id,args.source_url)
    print(json.dumps(result,indent=2))
if __name__=='__main__':main()
