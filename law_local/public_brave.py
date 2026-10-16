"""Read public Brave web-result anchors; no API key, proxy, or negative proof.

Only identifiable result cards are parsed. Query echoes, navigation, and HTTP
success alone never mean a completed search. Limit callers to low-volume probes.
"""
from __future__ import annotations
from html.parser import HTMLParser
from urllib.parse import urlencode, urlparse
import subprocess

def fetch_brave_public(url,timeout=9):
    # Direct public HTTPS request from the Mac, no API, proxy, or paid service.
    process=subprocess.run(['curl','--location','--fail','--silent','--show-error',
                            '--max-redirs','2','--max-time',str(timeout),url],
                           capture_output=True,timeout=timeout+2,check=True)
    return process.stdout[:450000].decode('utf-8','replace')

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

def brave_public_search(lead,match_fn,fetch_fn=None,timeout=9):
    """Return source-linked, firm-matching Brave cards, not website absence."""
    fetch_fn=fetch_fn or fetch_brave_public
    term='"'+str(lead.get('firm','')).replace('"','')+'" law firm '+str(lead.get('city',''))+' '+str(lead.get('state',''))
    url='https://search.brave.com/search?'+urlencode({'q':term,'source':'web'})
    try:
        page=fetch_fn(url,timeout=timeout)
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
                'query':term,'reason':type(exc).__name__}
