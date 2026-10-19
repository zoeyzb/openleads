"""Discover actual public firm/headcount profile URLs, never guessed paths.

For a Maps business, search a public RSS index for exact firm identity
and then fetch the *returned* original profile URL. Search results are
discovery hints, NOT source-verified headcounts or websites. Blocked sources
are skipped, not proxied/bypassed.
"""
from __future__ import annotations
import re
from urllib.parse import urlencode, urlparse
from xml.etree import ElementTree as ET
from law_local.worker import fetch_public

_ALLOWED={
    "lawyer.com",
    "floridabar.org",
}
_FL_BAR_PATH="/directories/find-mbr/profile/"
_LAWYER_PREFIXES=("/firm/","/firms/")

def permitted_source(url):
    try:
        p=urlparse(str(url))
    except ValueError:
        return False
    host=(p.hostname or "").lower().removeprefix("www.")
    path=p.path.lower()
    if p.scheme!="https" or host not in _ALLOWED:
        return False
    if host=="floridabar.org":
        return path==_FL_BAR_PATH and "num=" in p.query.lower()
    return path.startswith(_LAWYER_PREFIXES) and path.endswith(".html")

def parse_bing_rss(xml):
    try:
        root=ET.fromstring(xml)
    except ET.ParseError:
        return None
    if not root.tag.lower().endswith("rss"):
        return None
    urls=[]
    for item in root.findall(".//item"):
        raw=(item.findtext("link") or "").strip()
        if permitted_source(raw) and raw not in urls:
            urls.append(raw)
    return urls

def source_queries(firm,city="",state=""):
    clean=" ".join(str(firm or "").split()).replace('"',"")
    if len(clean)<8:
        return []
    city=" ".join(str(city or "").split()).replace('"',"")
    state=str(state or "").upper().strip()
    where=" ".join(v for v in (city,state) if v)
    # Use two independent source families; Florida Bar lists firm size,
    # published office phone, and often a professional contact email.
    q=[
        f'"{clean}" site:lawyer.com/firm',
        f'"{clean}" site:lawyer.com/firms',
    ]
    if state=="FL":
        q.insert(0,f'"{clean}" {where} site:floridabar.org/directories/find-mbr/profile')
    return q

def real_profile_urls(firm,city="",state="",fetch_fn=None,seconds_per_request=8):
    fetch_fn=fetch_fn or fetch_public
    found=[]
    responded=0
    errors=[]
    for q in source_queries(firm,city,state):
        url="https://www.bing.com/search?"+urlencode({"q":q,"format":"rss"})
        try:
            data=fetch_fn(url,timeout=seconds_per_request)
            results=parse_bing_rss(data)
            if results is None:
                errors.append("non_rss_search_response")
                continue
            responded+=1
            for actual in results:
                if actual not in found:
                    found.append(actual)
        except Exception as exc:
            errors.append(str(exc)[:125])
    return {"urls":found[:15],"queries":len(source_queries(firm,city,state)),
            "responded":responded,"failures":errors}
