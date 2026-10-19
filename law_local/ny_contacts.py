"""Scoped official NY registration contacts; discovery never grants qualification."""
from __future__ import annotations
import argparse, hashlib, json, re
from pathlib import Path
from urllib.parse import urlencode, urlparse, parse_qs
from law_local.ny_roster import ROOT, collect


def source_url(lead):
    company=str(lead['firm']).replace("'", "''")
    return ROOT+'?'+urlencode({'$select':'company_name,phone_number,city,state,status',
        '$where':"status='Currently registered' AND state='NY' AND company_name='"+company+"'",
        '$limit':500,'$order':'phone_number,city'})


def valid_source(url,lead):
    try:
        parsed=urlparse(url)
        return (lead.get('state')=='NY' and parsed.scheme=='https'
            and parsed.netloc=='data.ny.gov' and parsed.path=='/resource/eqw2-r5nb.json'
            and not parsed.fragment and parse_qs(parsed.query)==parse_qs(urlparse(source_url(lead)).query))
    except (TypeError,ValueError,KeyError):return False


def private_practice_label(firm):
    from law_local.worker import clearly_non_private_practice,generic_practice_label
    # Employer names alone can describe in-house counsel. This source route
    # requires explicit law-practice wording, not merely an LLP suffix.
    return bool(re.search(r'(?i)\b(?:law|attorneys?|lawyers?|legal|litigation)\b',firm)
        and not generic_practice_label(firm) and not clearly_non_private_practice(firm)
        and not re.search(r'(?i)\b(?:department|government|public defender|district attorney|court|university|school|agency|legal services fund|legal aid)\b',firm))


def scoped_contact(raw,lead):
    from law_local.worker import norm,normalize_phone,utc_now
    if not valid_source(lead.get('source_url',''),lead) or not private_practice_label(lead.get('firm','')):
        return None
    try:
        rows=json.loads(raw)
        if not isinstance(rows,list) or len(rows)>500:return None
        match=[r for r in rows if isinstance(r,dict)
            and norm(r.get('company_name'))==norm(lead['firm'])
            and normalize_phone(r.get('phone_number'))==normalize_phone(lead['phone'])
            and r.get('state')=='NY' and r.get('status')=='Currently registered'
            and (not lead.get('city') or norm(r.get('city'))==norm(lead['city']))]
        if not match:return None
        return {'attorneys':0,'emails':[],'website_candidates':[],
            'scoped_contact_matched':True,'official_contact':{
                'company':lead['firm'],'phone':normalize_phone(lead['phone']),
                'state':'NY','city':match[0].get('city',''),
                'registration_status':'Currently registered','source_url':lead['source_url'],
                'checked_at':utc_now(),'source_sha256':hashlib.sha256(raw.encode()).hexdigest()}}
    except (ValueError,TypeError,KeyError):return None


def export_proof_matches(row,evidence):
    from law_local.worker import norm,normalize_phone
    proof=evidence.get('official_contact',{})
    return (valid_source(row['source_url'],dict(row))
        and proof.get('source_url')==row['source_url']
        and proof.get('registration_status')=='Currently registered'
        and proof.get('state')=='NY' and private_practice_label(row['firm'])
        and norm(proof.get('company'))==norm(row['firm'])
        and normalize_phone(proof.get('phone'))==normalize_phone(row['phone'])
        and bool(re.fullmatch(r'[a-f0-9]{64}',proof.get('source_sha256',''))))


def stage(db,maximum=20,acquire=True):
    from law_local.worker import normalize_phone
    maximum=max(1,min(40,int(maximum)))
    acquisition=collect(db,max_pages=1,page_size=500,seconds=25) if acquire else {}
    known={normalize_phone(r[0]) for r in db.conn.execute('SELECT phone FROM candidates')}
    rows=db.conn.execute("SELECT company,phone,city FROM ny_registration_groups WHERE status='possible_private_law_firm' ORDER BY checked_at DESC,id")
    added=0;skipped=0
    for row in rows:
        phone=normalize_phone(row['phone'])
        if not phone or phone in known or not private_practice_label(row['company']):
            skipped+=1;continue
        lead={'firm':row['company'],'phone':phone,'city':row['city'],'state':'NY'}
        lead['source_url']=source_url(lead)
        if db.add(lead):added+=1;known.add(phone)
        if added>=maximum:break
    return {'official_ny_acquisition':acquisition,'added_unverified':added,
            'skipped_known_phone_or_ambiguous_employer':skipped,'qualified_created':0}


def main():
    from law_local.worker import SqliteQueue
    p=argparse.ArgumentParser();p.add_argument('--db',default=str(Path.home()/'lead-workspace/law-leads.sqlite3'))
    p.add_argument('--max',type=int,default=20);args=p.parse_args();db=SqliteQueue(args.db)
    try:print(json.dumps(stage(db,args.max)),flush=True)
    finally:db.close()

if __name__=='__main__':main()
