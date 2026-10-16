"""Free, source-first Lawyer.com firm discovery from Common Crawl CDX indexes.

Only processes public robots-permitted firm pages. Directory firm size, name,
phone and website link are evidence; absent website link is NOT no-site proof.
Checkpointed in existing Mac SQLite; no external credentials or paid API.
"""
from __future__ import annotations
import argparse,csv,html,json,re,sqlite3,time
from pathlib import Path
from urllib.parse import urlencode,urlparse
from urllib.request import Request,urlopen
from urllib.error import HTTPError
from urllib import robotparser
from law_local.worker import SqliteQueue,fetch_public,reader,normalize_phone,norm,utc_now
from law_local.florida_roster import clearly_non_law_employer

CC_INDEX='https://index.commoncrawl.org/CC-MAIN-2026-39-index'
INDEX_PATTERN='lawyer.com/firm/a*'
FIRM_PATH=re.compile(r'^/firm/[a-z0-9-]+\.html$',re.I)
H_TAG=re.compile(r'<h[1-3]\b[^>]*>(.*?)</h[1-3]>',re.I|re.S)
SIZE=re.compile(r'\bFirm\s+Size\s*:\s*(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\b',re.I)
PHONE=re.compile(r'\bCall\s+([\d().\s-]{10,24})\b',re.I)
URL_ALLOWED_HOSTS={'lawyer.com','www.lawyer.com'}

def valid_profile_url(url):
 try:
  p=urlparse(url)
  return p.scheme=='https' and p.hostname in URL_ALLOWED_HOSTS and bool(FIRM_PATH.fullmatch(p.path)) and not p.query
 except (ValueError,TypeError):return False

def parse_index_lines(lines,max_urls=2000):
 urls=[];seen=set()
 for line in lines:
  try: url=json.loads(line)['url']
  except (ValueError,TypeError,KeyError):continue
  if valid_profile_url(url) and url not in seen:
   seen.add(url);urls.append(url)
   if len(urls)>=max_urls:break
 return urls

def index_urls(index=CC_INDEX,max_urls=700,timeout=18,pattern=INDEX_PATTERN):
 url=index+'?'+urlencode({'url':pattern,'output':'json','filter':'status:200'})
 try:
  with urlopen(Request(url,headers={'User-Agent':'OpenLeads-Law-Evidence/1.0'}),timeout=timeout) as response:
   if response.status!=200:raise ValueError('CDX HTTP response not 200')
   return parse_index_lines((raw.decode('utf-8','replace') for raw in response),max_urls)
 except HTTPError as exc:
  if exc.code==404:return []  # The index has no entries for this partition.
  raise

def extract_profile(url,source):
 if not valid_profile_url(url):return None,'invalid_profile_url'
 p=reader(source);plain=' '.join(p.parts)
 m=SIZE.search(plain)
 if not m:return None,'no_explicit_size_range'
 lo,hi=map(int,m.groups())
 if not 2<=lo<=hi<=10:return None,'outside_firm_size'
 headings=[]
 for raw in H_TAG.findall(source):
  title=' '.join(html.unescape(re.sub('<[^>]*>',' ',raw)).split())
  if title:headings.append(title)
 # Firm heading is repeated on a genuine directory page, unlike nav headings.
 names=[x for x in headings if
        not re.search(r'(?i)^(?:resources|lawyer services|main office|office hours|log in|contact|lawyers)$',x)]
 candidate=None
 for name in names:
  if names.count(name)>=2 and len(name)>=7 and len(name)<=110 and not clearly_non_law_employer(name):
   if not re.search(r'(?i)^(?:connect with|lawyer login|get matched|thank you|search by)',name):
    candidate=name;break
 if not candidate:return None,'no_firm_heading'
 match=PHONE.search(plain)
 phone=normalize_phone(match.group(1)) if match else ''
 if not phone:return None,'no_published_business_phone'
 owned=[]
 for href,label in p.links:
  if 'visit site' not in (label or '').lower() and 'website' not in (label or '').lower():continue
  target=urlparse(href)
  if target.scheme in ('http','https') and target.hostname and target.hostname not in URL_ALLOWED_HOSTS:
   owned.append(href)
 # Explicit owned website = exclude from no-website queue.
 lead={'firm':candidate,'phone':phone,'city':'','state':'','source_url':url,'firm_size_low':lo,'firm_size_high':hi,'owned_site_hints':owned[:3]}
 return lead,'has_owned_website' if owned else 'candidate_needs_site_audit'

def ensure(con):
 con.executescript('''CREATE TABLE IF NOT EXISTS cc_law_profile_urls(url TEXT PRIMARY KEY,checked_at TEXT DEFAULT '',status TEXT DEFAULT 'pending',firm TEXT DEFAULT '',phone TEXT DEFAULT '',firm_size_low INTEGER,firm_size_high INTEGER,website TEXT DEFAULT ''); CREATE INDEX IF NOT EXISTS idx_cc_profile_status ON cc_law_profile_urls(status); CREATE TABLE IF NOT EXISTS cc_law_cursors(letter TEXT PRIMARY KEY,attempts INTEGER NOT NULL DEFAULT 0,last_error TEXT NOT NULL DEFAULT '',completed_at TEXT NOT NULL DEFAULT '');''')
 con.commit()

def run(db_path,catalog_path,max_fetch=35,seed_urls=None,fetch=fetch_public,delay=0.5):
 queue=SqliteQueue(db_path)
 con=sqlite3.connect(catalog_path,timeout=20);ensure(con)
 try:
  index_report={}
  if seed_urls is None:
   import string
   # Cover new alphabetical regions incrementally; retry failed indexes later.
   history={r[0]:r[1] for r in con.execute("SELECT letter,attempts FROM cc_law_cursors WHERE completed_at = ''")}
   done={r[0] for r in con.execute("SELECT letter FROM cc_law_cursors WHERE completed_at != ''")}
   remaining=[x for x in string.ascii_lowercase if x not in done]
   due=min(remaining,key=lambda letter:(history.get(letter,0),letter)) if remaining else None
   if due:
    try:
     seed_urls=index_urls(pattern=f'lawyer.com/firm/{due}*')
     con.execute("INSERT INTO cc_law_cursors(letter,attempts,completed_at,last_error) VALUES(?,1,?,'') ON CONFLICT(letter) DO UPDATE SET attempts=attempts+1,completed_at=excluded.completed_at,last_error=''",(due,utc_now()))
     con.commit()
     index_report={'partition':due,'index_urls':len(seed_urls),'index_status':'ok'}
    except Exception as exc:
     con.execute("INSERT INTO cc_law_cursors(letter,attempts,last_error) VALUES(?,1,?) ON CONFLICT(letter) DO UPDATE SET attempts=attempts+1,last_error=excluded.last_error",(due,type(exc).__name__))
     con.commit()
     seed_urls=[]
     index_report={'partition':due,'index_status':'unavailable','reason':type(exc).__name__}
   else:
    seed_urls=[]
  added=0
  for url in seed_urls:
   if valid_profile_url(url):added+=int(con.execute('INSERT OR IGNORE INTO cc_law_profile_urls(url) VALUES(?)',(url,)).rowcount>0)
  con.commit()
  items=[row[0] for row in con.execute("SELECT url FROM cc_law_profile_urls WHERE status='pending' ORDER BY url LIMIT ?",(max_fetch,))]
  counts={'index':index_report,'urls_newly_indexed':added,'attempted':0,'candidates_added':0,'website_excluded':0,'fetch_failures':0,'not_qualified':0}
  for url in items:
   counts['attempted']+=1
   try:
    body=fetch(url,timeout=10)
    lead,status=extract_profile(url,body)
   except Exception:
    lead,status=None,'fetch_failed';counts['fetch_failures']+=1
   if status=='has_owned_website':counts['website_excluded']+=1
   elif status=='candidate_needs_site_audit':
    # These are SOURCE-VERIFIED CANDIDATES, not qualified calling records.
    if queue.add(lead):counts['candidates_added']+=1
   else:counts['not_qualified']+=1
   con.execute('''UPDATE cc_law_profile_urls SET checked_at=?,status=?,firm=?,phone=?,firm_size_low=?,firm_size_high=?,website=? WHERE url=?''',(
       utc_now(),status,(lead or {}).get('firm',''),(lead or {}).get('phone',''),(lead or {}).get('firm_size_low'),(lead or {}).get('firm_size_high'),';'.join((lead or {}).get('owned_site_hints',[])),url))
   con.commit()
   if delay:time.sleep(delay)
  counts['stored_urls']=con.execute('SELECT count(*) FROM cc_law_profile_urls').fetchone()[0]
  counts['calling_qualified']=queue.counts()['calling_qualified']
  return counts
 finally:con.close();queue.close()

def main():
 p=argparse.ArgumentParser();p.add_argument('--db',default=str(Path.home()/'lead-workspace/law-leads.sqlite3'))
 p.add_argument('--catalog',default=str(Path.home()/'lead-workspace/research_catalog.sqlite3'))
 p.add_argument('--max',type=int,default=35)
 args=p.parse_args()
 print(json.dumps(run(args.db,args.catalog,max_fetch=args.max)))
if __name__=='__main__':main()
