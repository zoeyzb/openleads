"""Prioritize already published emails; never qualify from catalog labels."""
import argparse,json,sqlite3
from pathlib import Path
from law_local.worker import SqliteQueue,norm,normalize_phone
from law_local.florida_roster import clearly_non_law_employer,NON_PRIVATE

def bridge(root,limit=25):
 root=Path(root);q=SqliteQueue(root/"law-leads.sqlite3")
 report={"added_email_source_candidates":0,"excluded":0,"qualified_created":0}
 if not (root/"research_catalog.sqlite3").is_file():return report
 try:
  active=q.conn.execute("SELECT count(*) FROM candidates WHERE status='pending'").fetchone()[0]
  limit=min(max(0,limit),max(0,200-active))
  if not limit:return report
  con=sqlite3.connect('file:'+str(root/'research_catalog.sqlite3')+'?mode=ro',uri=True);con.row_factory=sqlite3.Row
  try:
   if not con.execute("SELECT 1 FROM sqlite_master WHERE name='plea_firm_research'").fetchone():return report
   rows=con.execute("SELECT * FROM plea_firm_research WHERE website_status NOT IN ('review_website','published_owned_website') ORDER BY CASE WHEN website_status='screened_no_site' THEN 0 ELSE 1 END,firm").fetchall()
   for row in rows:
    if report['added_email_source_candidates']>=limit:break
    data=json.loads(row['research_json'])
    if clearly_non_law_employer(row['firm']) or NON_PRIVATE.search(row['firm']) or data.get('shared_phone_conflict'):
     report['excluded']+=1;continue
    members=data.get('members',[])
    if not members or len(data.get('states',[]))!=1 or not normalize_phone(row['phone']):continue
    lead={'firm':row['firm'],'phone':row['phone'],'state':data['states'][0],
          'city':data['cities'][0] if len(data.get('cities',[]))==1 else '',
          'source_url':members[0]['source_url']}
    report['added_email_source_candidates']+=int(q.add(lead))
  finally:con.close()
 finally:q.close()
 return report
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--max',type=int,default=25);a=p.parse_args()
 print(json.dumps(bridge(Path.home()/'lead-workspace',max(1,min(a.max,100)))))
