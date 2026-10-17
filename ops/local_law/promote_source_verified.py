"""Complete the Maps->strict eligible conversion with live, scoped public evidence.

No source-proven headcount, published email/MX, matched phone, active private
practice, or two healthy independent website searches => NO promotion.
Manifests with published business contacts must stay outside Git.
"""
from __future__ import annotations
import argparse
import json
import re
from pathlib import Path
from urllib.parse import urlparse
from law_local.free_search import search_firm
from law_local.site_provider_health import audit_provider_health
from law_local.worker import (SqliteQueue, classify_search_results, domain_has_mail,
                              EMAIL_RE, fetch_public, _third_party,
                              normalize_phone, norm, utc_now)


def canonical(name):
    words=norm(name).split()
    while words and words[-1] in ('llc','pllc','pc','aplc'):
        words.pop()
    while len(words)>=3 and words[-3:]==['attorneys','at','law']:
        words=words[:-3]
    return ' '.join(words)


def exact_contact_block(html,firm,phone,email):
    """Extract a specific public directory card, never an email in its footer."""
    parts=re.split(r'(?is)<div\b[^>]*class=["\']row attorney["\'][^>]*>',html)
    if len(parts)>1:
        chunks=[p.split('</div></div>',1)[0] for p in parts[1:]]
    else:
        # Only isolated contact pages can be treated as one business profile.
        chunks=[html] if len(html)<=35000 else []
    for chunk in chunks:
        # Avoid arbitrary pages naming the firm AND phone but advertising
        # somebody else's email in another section of the same document.
        body=norm(re.sub(r'<[^>]+>',' ',chunk))
        if (canonical(firm) in body and normalize_phone(phone) and
            normalize_phone(phone) in {normalize_phone(x.group())
                     for x in re.finditer(r'(?<!\d)(?:\+?1[\s.()\-]*)?\(?[2-9]\d{2}\)?[\s.()\-]*[2-9]\d{2}[\s.\-]*\d{4}(?!\d)',chunk)}
            and email.lower() in chunk.lower() and EMAIL_RE.fullmatch(email)):
            return chunk
    return ''


def named_practitioners_proof(html,firm,names):
    """A reviewer confirms the identified small-practice team from a named source.

    This is source-backed, but cannot be generalized to large firms or inferred
    from a city/state active-bar count. All named lawyers must be present.
    """
    if not isinstance(names,list) or len(names)<2 or len(names)>10 or len({norm(n) for n in names})!=len(names):
        return False
    text=norm(re.sub(r'<[^>]+>',' ',html))
    if canonical(firm) not in text:
        return False
    return all(norm(name) in text for name in names)


def qualify(db_path,review,fetch=fetch_public,search=search_firm,
            health=None,mx=domain_has_mail):
    """Atomic candidate promotion for a reviewed, source-backed eligible map record."""
    lead=review.get('lead',{})
    phone=normalize_phone(lead.get('phone'))
    email=str(review.get('email','')).strip().lower()
    expected_map_id=str(review.get('map_id',''))
    report={'new_qualified':0,'reason':'unverified','firm':lead.get('firm','')}
    if (not phone or not expected_map_id or not review.get('private_practice_confirmed') is True or
        not review.get('reviewer') or not EMAIL_RE.fullmatch(email) or
        not 2<=len(review.get('named_attorneys',[]))<=10 or
        not review.get('firmwide_2_10_review_confirmed') is True):
        return {**report,'reason':'incomplete_review_requirements'}
    sources=review.get('sources',{})
    if any(not (isinstance(sources.get(key),str) and sources[key].startswith('https://'))
           for key in ('identity','email','headcount')):
        return {**report,'reason':'missing_public_source_urls'}
    # Source pages must be independent business listings. A firm's own
    # contact page proves the existence of an owned website immediately.
    identity_host=urlparse(sources['identity']).hostname or ''
    if not _third_party(identity_host):
        return {**report,'reason':'identity_source_may_be_owned_site'}
    candidate=dict(lead)
    candidate['source_url']=sources['identity']
    db=SqliteQueue(db_path)
    try:
        map_row=db.conn.execute('SELECT * FROM maps_raw_candidates WHERE map_id=?',(expected_map_id,)).fetchone()
        if (map_row is None or normalize_phone(map_row['phone'])!=phone or
            canonical(map_row['firm'])!=canonical(lead.get('firm')) or
            map_row['state']!=lead.get('state')):
            return {**report,'reason':'maps_identity_phone_mismatch'}
        if any(normalize_phone(row[0])==phone for row in db.conn.execute(
                "SELECT phone FROM candidates WHERE status IN ('strict_eligible','call_qualified_no_email')")):
            return {**report,'reason':'duplicate_verified_phone'}
        prior_row=db.conn.execute('SELECT * FROM candidates WHERE id=?',(db._id(candidate),)).fetchone()
        if prior_row is not None:
            try:
                prior=json.loads(prior_row['result_json'] or '{}')
            except (ValueError,TypeError):
                return {**report,'reason':'existing_candidate_evidence_corrupt'}
            # Previously published or suspected owned sites require a
            # separate explicit URL-by-URL resolution, not a fresh negative
            # search that silently overwrites an adverse record.
            if (prior_row['status'] in ('review_website','rejected_inactive','review_inactive') or
                prior.get('eligibility_hold') or prior.get('owned_site_url') or
                prior.get('site_status') in ('published_owned_website','review_website')):
                return {**report,'reason':'existing_adverse_evidence_hold'}
        try:
            identity_html=fetch(sources['identity'],timeout=12)
            email_html=fetch(sources['email'],timeout=12) if sources['email']!=sources['identity'] else identity_html
            count_html=fetch(sources['headcount'],timeout=12)
        except Exception as exc:
            return {**report,'reason':'public_source_unavailable','error':type(exc).__name__}
        if not exact_contact_block(identity_html,lead['firm'],phone,email) or not exact_contact_block(email_html,lead['firm'],phone,email):
            return {**report,'reason':'no_scoped_published_phone_and_email'}
        if not named_practitioners_proof(count_html,lead['firm'],review['named_attorneys']):
            return {**report,'reason':'headcount_source_not_matched'}
        try:
            domain=email.rsplit('@',1)[1]
            if not mx(domain):
                return {**report,'reason':'email_mx_not_verified'}
        except Exception:
            return {**report,'reason':'email_mx_not_verified'}
        checked=health() if health is not None else audit_provider_health(lookups=search)
        if checked.get('status')!='usable' or not checked.get('positive_control_found'):
            return {**report,'reason':'website_positive_control_failed'}
        response=search(candidate)
        if (len(response)<2 or [r.get('provider') for r in response[:2]]!=
                ['searxng:google cse','searxng:yahoo']):
            return {**report,'reason':'untrusted_search_providers'}
        site=classify_search_results(response)
        if site['status']!='screened_no_site':
            return {**report,'reason':'owned_site_or_unknown','site_signal':site['status']}
        evidence={'firm':lead['firm'],'phone':phone,'status':'strict_eligible',
            'qualification_scope':'law_no_owned_website_2_10_email',
            'source_qualification_method':'reviewed_named_team_published_email',
            'attorneys':len(review['named_attorneys']),
            'firmwide_2_10_review_confirmed':True,'named_attorneys':review['named_attorneys'],
            'headcount_source':sources['headcount'],'source_url':sources['identity'],
            'email':email,'email_source':sources['email'], 'email_mx_ok':True,
            'private_practice_confirmed':True,
            'site_status':'screened_no_site',
            'site_evidence':{'providers':[{'provider':r['provider'],'responded':r['responded'],
                                          'urls':r['urls'][:15]} for r in response[:2]],
                             'control':checked,'checked_at':utc_now()},
            'review_method':'live_source_verified_named_team',
            'source_proof':{'identity_source':sources['identity'],'email_source':sources['email'],
                 'headcount_source':sources['headcount'],'reviewer':review['reviewer'],
                 'verified_at':utc_now(), 'headcount_basis':'named 2–10 lawyers with reviewed firmwide scope'},
            'checked_at':utc_now()}
        # Verify the evidence contract before altering the live calling DB.
        if not db._verified_for_export({'phone':phone,'source_url':sources['identity']},
                                        evidence,'strict_eligible'):
            return {**report,'reason':'export_proof_gate_failed'}
        baseline=db.counts()['calling_qualified']
        db.add(candidate)
        db.record(candidate,evidence)
        stored=db.conn.execute('SELECT * FROM candidates WHERE id=?',(db._id(candidate),)).fetchone()
        if (stored is None or stored['status']!='strict_eligible' or
            not db._verified_for_export(stored,json.loads(stored['result_json']),'strict_eligible')):
            return {**report,'reason':'post_write_proof_gate_failed'}
        verified_increment=max(0,db.counts()['calling_qualified']-baseline)
        return {**report,'new_qualified':verified_increment,
                'reason':'published_phone_email_attorneys_and_no_owned_site_verified',
                'record_id':db._id(candidate)}
    finally:
        db.close()


def main():
    p=argparse.ArgumentParser(description='Promote only fully reviewed small-law-practice business contacts')
    p.add_argument('--db',default=str(Path.home()/'lead-workspace/law-leads.sqlite3'))
    p.add_argument('--review-file',required=True,type=Path)
    args=p.parse_args()
    print(json.dumps(qualify(args.db,json.loads(args.review_file.read_text())),indent=2))
if __name__=='__main__':main()
