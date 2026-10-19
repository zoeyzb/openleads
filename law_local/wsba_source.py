"""Bounded, checkpointed discovery of actual public Washington Bar profiles.

No guessed member IDs. Typed active-lawyer/employer/phone/email fields bind
contacts; firm size is optional. A blank website field never proves no site.
"""
import argparse,json,re,time
from datetime import datetime,timezone,timedelta
from urllib.parse import urlparse,parse_qs
from law_local.worker import reader,norm,normalize_phone,EMAIL_RE,SqliteQueue,fetch_public,utc_now
SEED='https://www.mywsba.org/PersonifyEbusiness/Default.aspx?TabID=1538&Usr_ID=000000057117'
CITIES=('Seattle','Spokane','Tacoma','Vancouver','Bellevue','Olympia','Everett','Yakima','Bellingham','Kennewick','Wenatchee','Lake Stevens','Bremerton','Walla Walla','Longview')

def permitted(url):
 p=urlparse(url);q=parse_qs(p.query)
 return (p.scheme=='https' and (p.hostname or '').lower() in ('mywsba.org','www.mywsba.org')
         and p.path.lower()=='/personifyebusiness/default.aspx' and q.get('TabID')==['1538']
         and bool(re.fullmatch(r'\d+',q.get('Usr_ID',[''])[0])))

def field(html,name):
 m=re.search(r'(?is)<(?:span|a)\b[^>]*\bid=["\'][^"\']*_'+name+r'["\'][^>]*>(.*?)</(?:span|a)>',html)
 return m.group(1) if m else ''

def contact(url,html):
 if not permitted(url):return None,'untrusted_source'
 text=lambda name:' '.join(reader(field(html,name)).parts).strip()
 if text('lblStatus').lower()!='active' or text('lblEligibleToPractice').lower()!='yes' or text('lblLicenseType').lower()!='lawyer':return None,'not_active_lawyer'
 firm=text('lblAddCompanyName');employer=text('lblEmployer');address=text('lblAddress')
 if not firm or norm(firm)!=norm(employer):return None,'employer_mismatch'
 from law_local.florida_roster import clearly_non_law_employer,NON_PRIVATE
 classification=text('lblFirmSize')
 private_class=bool(re.search(r'(?i)law firm|sole practitioner|private practice',classification))
 unknown_class=norm(classification) in ('','unknown','not provided')
 private_name=bool(re.search(r'(?i)\b(law|attorney|attorneys)\b',firm))
 if (not (private_class or (unknown_class and private_name))
     or clearly_non_law_employer(firm) or NON_PRIVATE.search(firm)):return None,'not_private_law_firm'
 if not re.search(r'\bWA\s+\d{5}',address) or 'united states' not in address.lower():return None,'not_us_wa_contact'
 phone=normalize_phone(text('lblPhone'));emails=sorted(set(EMAIL_RE.findall(field(html,'lblEmail'))))
 if not phone or not emails:return None,'missing_public_phone_or_email'
 site=re.search(r'(?is)<a\b[^>]*\bid=["\'][^"\']*_hlWebsite["\'][^>]*>',html)
 sites=[u for u,label in reader((site.group()+'</a>') if site else '').links if urlparse(u).scheme in ('http','https')]
 return {'firm':firm,'phone':phone,'state':'WA','city':'','source_url':url,'emails':emails,'website_candidates':sites},'candidate'

def discover(db,fetch=None,search=None,max_queries=2,max_profiles=8,seconds=50):
 from law_local.free_search import searx_engine,SITE_ENGINES
 fetch=fetch or fetch_public
 search=search or (lambda query:searx_engine(query,SITE_ENGINES[0]))
 db.conn.execute('CREATE TABLE IF NOT EXISTS wsba_discovery_checks(kind TEXT,key TEXT,checked_at TEXT,result TEXT,PRIMARY KEY(kind,key))')
 cutoff=(datetime.now(timezone.utc)-timedelta(days=7)).isoformat(timespec='seconds');deadline=time.monotonic()+seconds
 out={'queries':0,'profiles_fetched':0,'candidates_added':0,'failures':0,'reasons':{}};urls=[SEED]
 def due(kind,key):
  row=db.conn.execute('SELECT checked_at,result FROM wsba_discovery_checks WHERE kind=? AND key=?',(kind,key)).fetchone()
  return not row or row[1] in ('unavailable','fetch_unavailable') or row[0]<=cutoff
 def record(kind,key,result):
  db.conn.execute('INSERT OR REPLACE INTO wsba_discovery_checks VALUES(?,?,?,?)',(kind,key,utc_now(),result));db.conn.commit()
 checkpoints=dict(db.conn.execute("SELECT key,checked_at FROM wsba_discovery_checks WHERE kind='query'").fetchall())
 for city in sorted(CITIES,key=lambda city:checkpoints.get(city,'')):
  if out['queries']>=max_queries or time.monotonic()>=deadline:break
  if not due('query',city):continue
  out['queries']+=1
  try:
   result=search('site:mywsba.org/PersonifyEbusiness/Default.aspx "'+city+'" "Email" "Law firm"')
   urls.extend(u for u in result.get('urls',[]) if permitted(u));record('query',city,'results' if result.get('responded') else 'unavailable')
   if not result.get('responded'):out['failures']+=1
  except (ValueError,OSError,TimeoutError):out['failures']+=1;record('query',city,'unavailable')
 for url in dict.fromkeys(urls):
  if out['profiles_fetched']>=max_profiles or time.monotonic()>=deadline:break
  if not due('profile',url):continue
  out['profiles_fetched']+=1
  try:
   lead,reason=contact(url,fetch(url,timeout=8))
   if lead:out['candidates_added']+=int(db.add({k:v for k,v in lead.items() if k not in ('emails','website_candidates')}))
  except (ValueError,OSError,TimeoutError):out['failures']+=1;reason='fetch_unavailable'
  out['reasons'][reason]=out['reasons'].get(reason,0)+1;record('profile',url,reason)
 return out
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--db',required=True);p.add_argument('--seconds',type=int,default=50);a=p.parse_args();q=SqliteQueue(a.db)
 try:print(json.dumps({'wsba_public_contacts':discover(q,seconds=a.seconds),'qualified_created':0}))
 finally:q.close()
