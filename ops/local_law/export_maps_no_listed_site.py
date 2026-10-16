"""Source-backed unverified Google Maps phone prospect export (NOT qualified)."""
import argparse,csv,json,sqlite3
from pathlib import Path
FIELDS=('Firm','Phone','City','State','Maps source','Maps website field','Independent website status','Calling qualified','Last website check')

def export(db_path,out_path):
 con=sqlite3.connect(db_path);con.row_factory=sqlite3.Row
 try:
  con.execute('''CREATE TABLE IF NOT EXISTS maps_website_checks(map_id TEXT PRIMARY KEY,checked_at TEXT,status TEXT,result_json TEXT)''')
  rows=con.execute('''SELECT m.firm,m.phone,m.city,m.state,m.maps_url,
    CASE WHEN m.status='unverified_headcount' THEN 'blank-or-social-only' ELSE m.status END AS maps_status,
    COALESCE(w.status,'not_checked') AS website_status,COALESCE(w.checked_at,'') AS checked_at
    FROM maps_raw_candidates m LEFT JOIN maps_website_checks w ON w.map_id=m.map_id
    WHERE COALESCE(w.status,'not_checked') IN ('not_checked','inconclusive','manual_followup_required')
    ORDER BY m.state,m.city,m.firm''').fetchall()
  path=Path(out_path);path.parent.mkdir(parents=True,exist_ok=True)
  tmp=path.with_suffix('.tmp')
  with tmp.open('w',newline='',encoding='utf-8') as fd:
   writer=csv.writer(fd);writer.writerow(FIELDS)
   for r in rows:
    writer.writerow((r['firm'],r['phone'],r['city'],r['state'],r['maps_url'],
     'not listed or social-profile only',r['website_status'],'NO',r['checked_at']))
  tmp.replace(path)
  return {'research_prospects':len(rows),'qualified_leads_created':0,'output':str(path),
   'warning':'Missing Maps website field is not independent proof of no owned website'}
 finally:con.close()
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--db',default=str(Path.home()/'lead-workspace/law-leads.sqlite3'))
 p.add_argument('--out',default=str(Path.home()/'lead-workspace/law-maps-no-site-listed-UNVERIFIED.csv'))
 args=p.parse_args();print(json.dumps(export(args.db,args.out)))
