"""Safely quarantine a Maps no-site observation contradicted by a live firm website.

An exact published phone on *another* firm's owned site is a shared-phone
identity conflict, not proof that the Maps listing itself owns that site.
Never change canonical candidate status or erase the original website search.
"""
import hashlib
import json
import re
import sqlite3
from urllib.parse import urlparse
from law_local.worker import _third_party, normalize_phone, utc_now, PHONE_RE


def quarantine(db_path, map_id, owner_name, owned_url, html, checked_at=None):
    host = (urlparse(owned_url).hostname or '').lower()
    if (urlparse(owned_url).scheme != 'https' or not host or
            _third_party(host) or not owner_name.strip()):
        raise ValueError('a publicly attributable, independently owned HTTPS website is required')
    text = re.sub(r'<[^>]+>', ' ', html)
    text = re.sub(r'\s+', ' ', text).casefold()
    owner_tokens = [token for token in re.findall(r'[a-z0-9]+', owner_name.casefold())
                    if len(token) > 3 and token not in ('and', 'firm', 'law')]
    if len(owner_tokens) < 2 or not all(token in text for token in owner_tokens):
        raise ValueError('website does not publish its named owner')
    con = sqlite3.connect(db_path, timeout=15)
    con.row_factory = sqlite3.Row
    try:
        con.execute('BEGIN IMMEDIATE')
        row = con.execute('''SELECT m.map_id,m.firm,m.phone,w.status,w.checked_at,w.result_json
            FROM maps_raw_candidates m JOIN maps_website_checks w ON w.map_id=m.map_id
            WHERE m.map_id=?''',(map_id,)).fetchone()
        if row is None:
            raise ValueError('unknown Maps candidate and audit')
        phone=normalize_phone(row['phone'])
        found={normalize_phone(''.join(g)) for g in PHONE_RE.findall(text)}
        if not phone or phone not in found:
            raise ValueError('the named website must publish the exact Maps business phone')
        if row['status'] == 'manual_followup_required':
            current = json.loads(row['result_json'] or '{}')
            if (current.get('conflict_kind') == 'other_practice_owned_site_shares_phone'
                    and current.get('owned_site_url') == owned_url):
                con.rollback()
                return {'changed':False,'idempotent':True,'map_id':map_id}
        if row['status'] != 'screened_no_site':
            raise ValueError('only previously cleared Maps observations may be quarantined')
        con.execute('''CREATE TABLE IF NOT EXISTS maps_site_conflict_history(
            map_id TEXT NOT NULL, observed_at TEXT NOT NULL, previous_checked_at TEXT,
            previous_status TEXT NOT NULL, previous_result_json TEXT NOT NULL,
            evidence_json TEXT NOT NULL)''')
        observation={'conflict_kind':'other_practice_owned_site_shares_phone',
            'map_id':map_id, 'firm':row['firm'],'phone':phone,
            'website_owner':owner_name,'owned_site_url':owned_url,
            'observed_at':checked_at or utc_now(),
            'published_page_sha256':hashlib.sha256(html.encode()).hexdigest(),
            'reason':'Owned website found for a different practice publishing the same phone; identity requires review, not no-website certification'}
        con.execute('''INSERT INTO maps_site_conflict_history VALUES(?,?,?,?,?,?)''',(
            map_id,observation['observed_at'],row['checked_at'],row['status'],
            row['result_json'],json.dumps(observation,sort_keys=True)))
        con.execute('''UPDATE maps_website_checks SET status='manual_followup_required',
            checked_at=?, result_json=? WHERE map_id=?''',(
            observation['observed_at'],json.dumps(observation,sort_keys=True),map_id))
        con.commit()
        return {'changed':True,'idempotent':False,'map_id':map_id,
                'conflict_kind':observation['conflict_kind']}
    except Exception:
        con.rollback()
        raise
    finally:
        con.close()
