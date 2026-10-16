"""Optional, attributed search API provider; never proof of absent website alone.

No automatic paid requests without an explicitly provided key and budget cap.
Provider errors, empty/invalid payloads and pagination failures return
responded=False rather than a false negative website assertion.
"""
from __future__ import annotations
import json
import os
from urllib.parse import urlencode,urlparse
from urllib.request import Request,urlopen

BASE='https://api.search.brave.com/res/v1/web/search'

def brave_search(query,*,key=None,fetch=None,timeout=8):
    key=key if key is not None else os.environ.get('BRAVE_SEARCH_API_KEY','')
    if not key:
        return {'responded':False,'urls':[],'reason':'missing_brave_api_key','provider':'brave'}
    if fetch is None:
        def fetch(url,headers,timeout):
            with urlopen(Request(url,headers=headers),timeout=timeout) as result:
                return result.read(300000).decode('utf-8','replace')
    url=BASE+'?'+urlencode({'q':query,'count':20,'country':'us','search_lang':'en'})
    try:
        data=json.loads(fetch(url,{'X-Subscription-Token':key,'Accept':'application/json'},timeout))
        items=data['web']['results']
        if not isinstance(items,list):raise ValueError('missing structured results')
        urls=[]
        for item in items:
            raw=item.get('url') if isinstance(item,dict) else None
            if isinstance(raw,str) and urlparse(raw).scheme=='https' and urlparse(raw).hostname:
                if raw not in urls:urls.append(raw)
        return {'responded':True,'urls':urls,'reason':'structured_results','provider':'brave'}
    except (ValueError,TypeError,KeyError,OSError) as exc:
        return {'responded':False,'urls':[],'reason':type(exc).__name__,'provider':'brave'}
