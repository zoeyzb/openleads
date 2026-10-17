"""Read public Brave web-result anchors; no API key, proxy, or negative proof.

Only identifiable result cards are parsed. Query echoes, navigation, and HTTP
success alone never mean a completed search. Limit callers to low-volume probes.
"""
from __future__ import annotations
from html.parser import HTMLParser
from urllib.parse import urlencode, urlparse
import subprocess

class ProviderFetchError(OSError):
    def __init__(self,reason,http_status=0,retry_after=0):
        super().__init__(reason)
        self.reason=reason
        self.http_status=http_status
        self.retry_after=retry_after

def fetch_brave_public(url,timeout=9):
    import tempfile,time
    from pathlib import Path
    from email.utils import parsedate_to_datetime
    with tempfile.TemporaryDirectory() as d:
        headers=Path(d)/"headers"
        process=subprocess.run(['curl','--location','--silent','--show-error',
            '--max-redirs','2','--max-time',str(timeout),'--dump-header',str(headers),
            '--write-out','\nOPENLEADS_HTTP_STATUS:%{http_code}',url],
            capture_output=True,timeout=timeout+2,check=False)
        if process.returncode:
            raise ProviderFetchError("transport_error_"+str(process.returncode))
        body,marker,status=process.stdout.rpartition(b'\nOPENLEADS_HTTP_STATUS:')
        code=int(status) if marker and status.isdigit() else 0
        retry=0
        for line in headers.read_text(errors='replace').splitlines() if headers.exists() else []:
            if line.lower().startswith('retry-after:'):
                value=line.split(':',1)[1].strip()
                try:retry=max(0,int(value))
                except ValueError:
                    try:retry=max(0,parsedate_to_datetime(value).timestamp()-time.time())
                    except (ValueError,TypeError,OverflowError):pass
        if code!=200:
            raise ProviderFetchError('http_'+str(code),code,retry)
        return body[:450000].decode('utf-8','replace')

def guarded_fetch(fetch,url,timeout,state_path):
    """Serialize provider requests and persist outages across workers/runs."""
    import fcntl,json,os,time
    from pathlib import Path
    state=Path(state_path);state.parent.mkdir(parents=True,exist_ok=True)
    with state.with_suffix('.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        try:old=json.loads(state.read_text())
        except (OSError,ValueError):old={}
        if float(old.get('retry_at',0))>time.time():
            raise ProviderFetchError('provider_cooldown',old.get('http_status',0),old['retry_at']-time.time())
        try:
            page=fetch(url,timeout=timeout)
            lower=page.lower()
            if 'captcha' in lower or 'verify you are human' in lower:
                raise ProviderFetchError('access_challenge',200,86400)
            record={'reason':'request_spacing','http_status':200,'retry_at':time.time()+20}
        except Exception as exc:
            reason=getattr(exc,'reason',type(exc).__name__)
            status=getattr(exc,'http_status',0)
            seconds=max(getattr(exc,'retry_after',0),21600 if status==429 else 86400 if status==403 or reason=='access_challenge' else 900)
            record={'reason':reason,'http_status':status,'retry_at':time.time()+seconds}
            raise
        finally:
            if 'record' in locals():
                temp=state.with_suffix('.tmp')
                temp.write_text(json.dumps(record));temp.chmod(0o600);os.replace(temp,state)
        return page

class BraveResultParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.depth=0
        self.anchor=None
        self.words=[]
        self.seen_first=False
        self.results=[]

    def handle_starttag(self,tag,attrs):
        attrs=dict(attrs)
        if tag=='div':
            if self.depth:
                self.depth+=1
            elif attrs.get('data-type')=='web' and 'snippet' in attrs.get('class','').split():
                self.depth=1
                self.seen_first=False
        elif tag=='a' and self.depth and not self.seen_first and self.anchor is None:
            href=attrs.get('href','')
            parsed=urlparse(href)
            if parsed.scheme=='https' and parsed.hostname:
                self.anchor=href
                self.words=[]

    def handle_data(self,data):
        if self.anchor is not None:
            self.words.append(data)

    def handle_endtag(self,tag):
        if tag=='a' and self.anchor is not None:
            self.results.append((self.anchor,' '.join(self.words)))
            self.anchor=None
            self.words=[]
            self.seen_first=True
        elif tag=='div' and self.depth:
            self.depth-=1

def brave_public_search(lead,match_fn,fetch_fn=None,timeout=9,state_path=None):
    """Return source-linked, firm-matching Brave cards, not website absence."""
    from pathlib import Path
    persist=fetch_fn is None or state_path is not None
    fetch_fn=fetch_fn or fetch_brave_public
    state_path=Path(state_path) if state_path is not None else Path.home()/'lead-workspace/provider-state/brave.json'
    term='"'+str(lead.get('firm','')).replace('"','')+'" law firm '+str(lead.get('city',''))+' '+str(lead.get('state',''))
    url='https://search.brave.com/search?'+urlencode({'q':term,'source':'web'})
    try:
        page=guarded_fetch(fetch_fn,url,timeout,state_path) if persist else fetch_fn(url,timeout=timeout)
        parser=BraveResultParser()
        parser.feed(page[:450000])
        links=[]
        for href,label in parser.results:
            if match_fn(label,'',lead) and href not in links:
                links.append(href)
        return {'provider':'brave_public','responded':bool(links),
                'urls':links[:30], 'query':term,
                'reason':'firm_matched_result_cards' if links else 'no_parseable_matching_results'}
    except Exception as exc:
        return {'provider':'brave_public','responded':False,'urls':[],
                'query':term,'reason':getattr(exc,'reason',type(exc).__name__),
                'http_status':getattr(exc,'http_status',0),
                'retry_after_seconds':round(getattr(exc,'retry_after',0))}
