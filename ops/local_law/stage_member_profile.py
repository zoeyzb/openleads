"""Stage source-scoped business email/phone proof from public IRELA profiles.

A staging receipt is not qualified: headcount and website eligibility remain
independently unresolved until explicitly reviewed with direct dated sources.
"""
from __future__ import annotations
import argparse
from datetime import datetime,timezone
import json
import re
import sqlite3
from pathlib import Path
from urllib.parse import urlparse
from law_local.worker import EMAIL_RE, normalize_phone, domain_has_mail, fetch_public, reader
from ops.local_law.promote_source_verified import exact_contact_block, canonical

ROOT=Path.home()/"lead-workspace"


def source_data(html,url):
    parsed=urlparse(url)
    if ((parsed.hostname or '').lower().removeprefix('www.')!='irela.org' or
        not re.fullmatch(r'/Sys/PublicProfile/\d+',parsed.path,re.I)):
        return None
    start=html.find('memberDirectoryDetailsContainer')
    if start<0 or html.count('memberDirectoryDetailsHeaderContainer')!=1:
        return None
    tail=html[start:start+50000]
    end=re.search(r'class=["\'][^"\']*gadgetContentEditableArea',tail,re.I)
    if not end:return None
    block=tail[:end.start()]
    heading=re.search(r'<h3\b[^>]*>(.*?)</h3>',block,re.I|re.S)
    if not heading:return None
    firm=' '.join(reader(heading.group(1)).parts).strip()
    mailboxes=sorted(set(v.lower() for v in EMAIL_RE.findall(block)))
    return {'firm':firm,'emails':mailboxes}


def stage(map_id,source_url,root=ROOT,fetch=fetch_public,mx=domain_has_mail):
    receipt={'map_id':map_id,'new_strict_qualified':0,'new_calling_qualified':0,
             'email_staged':0,'status':'unverified'}
    parsed=urlparse(source_url)
    if (parsed.scheme!='https' or
        (parsed.hostname or '').lower().removeprefix('www.')!='irela.org' or
        not re.fullmatch(r'/Sys/PublicProfile/\d+',parsed.path,re.I) or
        parsed.port not in (None,443) or parsed.username or parsed.password or
        parsed.query or parsed.fragment):
        return {**receipt,'status':'unsupported_public_profile_source'}
    root=Path(root)
    main=sqlite3.connect(root/'law-leads.sqlite3')
    main.row_factory=sqlite3.Row
    try:
        rec=main.execute('SELECT * FROM maps_raw_candidates WHERE map_id=?',(map_id,)).fetchone()
        if rec is None:
            return {**receipt,'status':'maps_candidate_not_found'}
        try:html=fetch(source_url,timeout=12)
        except Exception as e:
            return {**receipt,'status':'public_profile_unavailable','reason':type(e).__name__}
        evidence=source_data(html,source_url)
        if not evidence or canonical(evidence['firm'])!=canonical(rec['firm']):
            return {**receipt,'status':'profile_identity_mismatch'}
        # Require exactly one scoped business email in this member profile,
        # never the public association footer or a second lawyer's contact.
        if len(evidence['emails'])!=1:
            return {**receipt,'status':'no_unique_member_email'}
        email=evidence['emails'][0]
        if not exact_contact_block(html,evidence['firm'],rec['phone'],email,source_url=source_url):
            return {**receipt,'status':'profile_email_phone_mismatch'}
        if not mx(email.rsplit('@',1)[1]):
            return {**receipt,'status':'business_email_domain_unverified'}
        research=sqlite3.connect(root/'research_catalog.sqlite3')
        try:
            research.execute('''CREATE TABLE IF NOT EXISTS external_evidence(
                 lead_id TEXT NOT NULL,kind TEXT NOT NULL,proof_url TEXT NOT NULL,
                 note TEXT NOT NULL,verified_at TEXT NOT NULL,
                 PRIMARY KEY(lead_id,kind,proof_url))''')
            key='maps:'+map_id.lower()
            note=json.dumps({'published_email':email,'firm':evidence['firm'],
                             'phone':normalize_phone(rec['phone']),
                             'scope':'single_member_public_profile',
                             'headcount':'unverified', 'owned_site':'not_audited'},sort_keys=True)
            cur=research.execute('''INSERT OR IGNORE INTO external_evidence
                (lead_id,kind,proof_url,note,verified_at) VALUES (?,?,?,?,?)''',
                (key,'published_email',source_url,note,
                 datetime.now(timezone.utc).isoformat(timespec='seconds')))
            research.commit()
            return {**receipt,'email_staged':int(cur.rowcount==1),
                    'status':'email_phone_sourced_needs_firmwide_size_and_site_audit',
                    'evidence_url':source_url}
        finally:research.close()
    finally:main.close()


def main():
    cli=argparse.ArgumentParser(description='Public association email/phone evidence, never automatic qualification')
    cli.add_argument('--map-id',required=True)
    cli.add_argument('--source-url',required=True)
    args=cli.parse_args()
    print(json.dumps(stage(args.map_id,args.source_url),indent=2))
if __name__=='__main__':main()
