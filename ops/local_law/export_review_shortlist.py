"""Private, source-linked RESEARCH queue. Never represents qualified law leads."""
from __future__ import annotations
import argparse,csv,sqlite3,re
from pathlib import Path
from law_local.worker import normalize_phone,norm
from law_local.florida_roster import clearly_non_law_employer,ambiguous_employer_identity,NON_PRIVATE
COLUMNS=('Firm','Phone','City','State','Observed in-state registered attorneys (NOT firmwide)',
 'Directory source','Source URL','Firmwide size (not required)','No owned website verified',
 'Qualified for calling','Research next step')
GENERIC=re.compile(r'(?i)^(attorney|lawyer|law firm|legal services|esquire|counsel)$')
FIRM_SIGNAL=re.compile(r'(?i)\b(law|lawyers?|attorneys?|legal|litigation|litigators?|LLP|PLLC|P\.?A\.?|P\.?C\.?)\b|\b[A-Za-z]{3,}\s*(?:&|AND)\s*[A-Za-z]{3,}\b')
NON_PRACTICE=re.compile(r'(?i)\b(in.house counsel|ACLU|legal aid|legal assistance|bar association|mediation|arbitration|ADRsource|university|public defender|prosecutor)\b')
def export(catalog,out,limit=1000):
 conn=sqlite3.connect(catalog);conn.row_factory=sqlite3.Row
 rows=conn.execute('''SELECT r.*,t.status AS triage_status,t.website_url AS triage_website,
 EXISTS(SELECT 1 FROM external_evidence e WHERE e.lead_id=r.lead_id AND e.kind='owned_website') AS owned_evidence
 FROM source_research r LEFT JOIN source_triage t ON t.lead_id=r.lead_id
 WHERE r.source IN ('FL roster','NY registrations')
 ORDER BY CASE WHEN t.status='needs_independent_firmwide_size_and_site' THEN 0 ELSE 1 END,
          CASE WHEN r.source='FL roster' THEN 0 ELSE 1 END,r.firm''').fetchall()
 selected=[];by_source={'FL roster':[],'NY registrations':[]};seen=set();reasons={}
 for r in rows:
  firm=str(r['firm'] or '').strip();phone=normalize_phone(r['phone'])
  why=None
  if not phone or not firm or len(norm(firm))<8:why='identity_or_phone_missing'
  elif (clearly_non_law_employer(firm) or ambiguous_employer_identity(firm) or NON_PRIVATE.search(firm)
        or GENERIC.fullmatch(firm) or NON_PRACTICE.search(firm) or not FIRM_SIGNAL.search(firm)):why='non_firm'
  elif r['owned_evidence'] or r['triage_website'] or r['proof_status']=='ineligible_owned_website' or r['triage_status'] in ('owned_site_hint','ineligible_owned_website','already_has_website'):why='owned_site_evidence'
  elif r['triage_status'] in ('identity_or_phone_unmatched','not_private_law_firm','source_unavailable'):why='identity_or_source_failed'
  key=(norm(firm),phone)
  if not why and key in seen:why='duplicate'
  if why: reasons[why]=reasons.get(why,0)+1;continue
  seen.add(key)
  by_source[r['source']].append([firm,phone,r['city'] or '',r['state'] or '',r['reported_attorneys'],r['source'],r['source_url'],'NOT REQUIRED','NO','NO','Verify identity and phone; check owned website using two healthy search sources'])
 # One source/state must not fill the entire national research queue.
 from itertools import zip_longest
 for pair in zip_longest(by_source['FL roster'],by_source['NY registrations']):
  for item in pair:
   if item is not None and len(selected)<limit:selected.append(item)
  if len(selected)>=limit:break
 conn.close();out=Path(out);out.parent.mkdir(parents=True,exist_ok=True)
 temp=out.with_suffix('.tmp')
 with temp.open('w',newline='',encoding='utf-8') as f:
  writer=csv.writer(f);writer.writerow(COLUMNS);writer.writerows(selected)
 temp.replace(out)
 return {'research_queue_rows':len(selected),'verified_qualified_leads_created':0,'file':str(out),'by_source':{source:sum(row[5]==source for row in selected) for source in by_source},'excluded_reasons':reasons,'warning':'UNVERIFIED: registered-attorney count is not firmwide size and website absence is not proven'}
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--catalog',default=str(Path.home()/'lead-workspace/research_catalog.sqlite3'))
 p.add_argument('--out',default=str(Path.home()/'lead-workspace/law-research-1000-UNVERIFIED.csv'))
 p.add_argument('--limit',type=int,default=1000);a=p.parse_args()
 import json;print(json.dumps(export(a.catalog,a.out,a.limit)))
