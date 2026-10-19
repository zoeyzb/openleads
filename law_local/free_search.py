"""Opt-in localhost search adapters. Third-party results are evidence, not proof of no website.

SearXNG issues *separate* Google CSE and Yep engine requests; neither the wrapper
nor a responsive HTTP status alone establishes an independent negative search.
YaCy uses its own P2P index for positive hints only: low coverage never qualifies.
"""
from __future__ import annotations
import json
import os
import re
import time
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

ALLOWED_HOSTS = {"127.0.0.1", "localhost"}
MAX_RESPONSE = 1024 * 1024
# Bound load on free upstreams across all worker threads in this process.
_ENGINE_LOCKS = {name: threading.Lock() for name in ('google','bing','google cse','yahoo','yandex','yep')}
_ENGINE_LAST_REQUEST = {}
ENGINE_INTERVAL_SECONDS = 5.0

def _paced_request(url, engine):
    with _ENGINE_LOCKS[engine]:
        delay=ENGINE_INTERVAL_SECONDS-(time.monotonic()-_ENGINE_LAST_REQUEST.get(engine,0))
        if delay>0:time.sleep(delay)
        _ENGINE_LAST_REQUEST[engine]=time.monotonic()
        return _read_json(url)

# Two independently indexed public-web search engines; each must recover
# known owned websites in live controls. No provider is treated as unlimited.
SITE_ENGINES = ('google cse', 'yep')
PREVIOUS_SITE_PROVIDERS = ('searxng:yandex', 'searxng:yep')
SITE_PROVIDERS = tuple('searxng:' + e for e in SITE_ENGINES)
LEGACY_SITE_PROVIDERS = ('searxng:google cse', 'searxng:yahoo')

def valid_provider_pair(results, legacy=False):
    if len(results) < 2:
        return False
    actual = tuple(item.get('provider') for item in results[:2])
    return actual == SITE_PROVIDERS or (legacy and actual in (LEGACY_SITE_PROVIDERS, PREVIOUS_SITE_PROVIDERS))



def local_origin(value, default_port):
    """No remote metasearch instances, credentials, paths or SSRF through config."""
    parsed = urlparse(value)
    if (parsed.scheme != "http" or parsed.hostname not in ALLOWED_HOSTS
            or parsed.username or parsed.password or parsed.path not in ("", "/")
            or parsed.query or parsed.fragment or parsed.port is None
            or not (1024 <= parsed.port <= 65535)):
        raise ValueError("search backend must be a localhost HTTP origin with explicit port")
    return "http://127.0.0.1:" + str(parsed.port)


def _read_json(url, fetch=None):
    if fetch is not None:
        return fetch(url)
    request = Request(url, headers={"User-Agent": "OpenLeads-Local-Fork-Integration/1.0", "Accept": "application/json"})
    with urlopen(request, timeout=8) as response:
        if response.status != 200:
            raise ValueError("search backend non-200 response")
        content = response.read(MAX_RESPONSE + 1)
        if len(content) > MAX_RESPONSE:
            raise ValueError("search backend oversized response")
    return json.loads(content)


def _urls(items, field, lead=None):
    if not isinstance(items, list):
        raise ValueError("search results not a list")
    result = []
    ignored = {"law", "firm", "group", "office", "offices", "off", "legal", "attorney", "attorneys", "lawyer", "lawyers", "the", "and", "llc", "llp", "pllc", "pc"}
    distinctive = [t for t in re.findall(r"[a-z0-9]+", str((lead or {}).get('firm', '')).lower()) if len(t) >= 3 and t not in ignored]
    for item in items[:30]:
        if not isinstance(item, dict):
            continue
        link = item.get(field)
        if not isinstance(link, str):
            continue
        parsed = urlparse(link)
        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            continue
        if lead is not None:
            # Search indexes sometimes return unrelated geographic/keyword hits.
            # Require every distinctive firm token in the actual hit metadata.
            context = ' '.join(str(item.get(key) or '') for key in ('title', 'content', 'description'))
            context += ' ' + re.sub(r'[^a-z0-9]+', ' ', (parsed.hostname or '').lower())
            words = set(re.findall(r'[a-z0-9]+', context.lower()))
            # A homepage may title itself just "Welcome" but use the
            # practice's exact distinctive name as its hostname. Keep that
            # positive candidate even without firm tokens in snippets.
            host_label=(parsed.hostname or '').lower().removeprefix('www.').split('.')[0]
            host_fold=re.sub(r'[^a-z0-9]', '', host_label.lower())
            direct_firm_domain=bool(len(distinctive)>=2 and
                                    all(token in host_fold for token in distinctive))
            phone=re.sub(r"\D", "", str((lead or {}).get("phone", "")))[-10:]
            phone_match=bool(len(phone)==10 and phone in re.sub(r"\D", "", context))
            name_match=bool(distinctive) and all(token in words or (len(token)>=5 and any(w.startswith(token) for w in words)) for token in distinctive)
            if not direct_firm_domain and not phone_match and not name_match:
                continue
            # Namesake obituaries and non-law businesses should not be treated
            # as potentially attributable law practice websites.
            legal_terms={'law','legal','lawyer','lawyers','attorney','attorneys',
                         'attorneyatlaw','esq','counsel','bar','litigation','advocacy'}
            context_tokens=words | set(re.findall(r'[a-z0-9]+', (parsed.path or '').lower()))
            if (not direct_firm_domain and not (legal_terms & context_tokens)
                    and not ('law' in host_fold or 'attorney' in host_fold)):
                continue
        result.append(link)
    return list(dict.fromkeys(result))[:15]


def searx_engine(query, engine, origin=None, fetch=None, lead=None):
    if engine not in ("google", "bing", "google cse", "yahoo", "yandex", "yep"):
        raise ValueError("unsupported named independent search engine")
    output = {"provider": "searxng:" + engine, "responded": False, "urls": [], "reason": "unavailable",
              "query": query, "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    try:
        url = local_origin(origin or os.environ.get("OPENLEADS_SEARXNG_URL", "http://127.0.0.1:18888"), 18888)
        request_url = url + "/search?" + urlencode({"q": query, "format": "json", "engines": engine, "language": "en-US"})
        payload = _read_json(request_url, fetch) if fetch is not None else _paced_request(request_url,engine)
        if not isinstance(payload, dict) or not isinstance(payload.get("results"), list):
            raise ValueError("invalid SearXNG results structure")
        failures = payload.get("unresponsive_engines") or []
        if failures:
            output["reason"] = "engine_unresponsive"
            return output
        # The per-engine parameter is mandatory; enforce attribution of any
        # result so a different engine cannot silently satisfy the query.
        entries = []
        for hit in payload["results"]:
            if not isinstance(hit, dict):
                continue
            names = hit.get("engines") or ([hit.get("engine")] if hit.get("engine") else [])
            if engine in names:
                entries.append(hit)
        output["urls"] = _urls(entries, "url", lead)
        # A genuinely empty result is normal for a firm with no web presence.
        # SearXNG echoes the exact query and includes an explicit, empty
        # unresponsive_engines list on successful zero-hit searches. Require
        # those fields AND the independently exercised, known-owned-site
        # preflight in the canonical worker before using these negatives.
        # A non-empty result supplied by a DIFFERENT engine is not success.
        completed_empty=(not payload["results"] and
                         payload.get("query")==query and
                         "unresponsive_engines" in payload)
        # A healthy control proves index access, not candidate relevance.
        # Neither irrelevant entries nor an empty SERP can clear a practice.
        output["responded"] = (bool(output["urls"]) if lead is not None
                               else bool(entries) or completed_empty)
        output["reason"] = ("results" if output["urls"] else
                           "no_relevant_candidate_results" if lead is not None
                           else "completed_no_attributed_results" if output["responded"]
                           else "empty_or_wrong_engine")
    except (ValueError, OSError, TimeoutError, TypeError, json.JSONDecodeError) as exc:
        output["reason"] = type(exc).__name__
    return output



def candidate_search(query, engine, lead):
    """Retry a completed but irrelevant name query with exact source phone.

    An outage never becomes a negative. The fallback requires a legal-context
    result containing the exact phone in its metadata, independently per engine.
    Name aliases and empty phone SERPs still cannot certify website absence.
    """
    initial=searx_engine(query,engine,lead=lead)
    phone=re.sub(r"\D","",str(lead.get('phone','')))[-10:]
    if initial.get('reason')!='no_relevant_candidate_results' or len(phone)!=10:
        return initial
    fallback_query='"'+phone+'" attorney'
    fallback=searx_engine(fallback_query,engine,lead={**lead,'firm':''})
    attempts=[initial,fallback]
    # Keep the original failed query when fallback is unavailable. In either
    # case the full trace is retained for review, including every positive URL.
    chosen=fallback if fallback.get('responded') is True and fallback.get('urls') else initial
    return {**chosen,'query_attempts':attempts,
            'urls':list(dict.fromkeys(initial.get('urls',[])+fallback.get('urls',[])))}


def yacy_search(query, origin=None, fetch=None, lead=None):
    """YaCy may find owned sites but its index misses too much to certify absence."""
    out = {"provider": "yacy:global", "responded": False, "urls": [], "reason": "positive_only"}
    try:
        url = local_origin(origin or os.environ.get("OPENLEADS_YACY_URL", "http://127.0.0.1:18090"), 18090)
        response = _read_json(url + "/yacysearch.json?" + urlencode({"query": query, "resource": "global", "maximumRecords": 10, "verify": "false"}), fetch)
        channels = response.get("channels") if isinstance(response, dict) else None
        if not isinstance(channels, list) or not channels or not isinstance(channels[0], dict):
            raise ValueError("invalid YaCy search response")
        out["urls"] = _urls(channels[0].get("items", []), "link", lead)
        out["reason"] = "positive_hint_only" if out["urls"] else "no_index_hits"
    except (ValueError, OSError, TimeoutError, TypeError, json.JSONDecodeError) as exc:
        out["reason"] = type(exc).__name__
    return out


def search_firm(lead):
    query = '"' + str(lead.get("firm", "")).replace('"', '') + '" law firm ' + str(lead.get("city", "")) + ' ' + str(lead.get("state", ""))
    # Google CSE and Yep independently recovered AXS and Baker McKenzie
    # on 2026-10-19; candidate relevance remains mandatory per engine.
    # Bounded independent requests in parallel preserve provider order while
    # reducing a two-provider outage from ~16s to ~8s per firm.
    with ThreadPoolExecutor(max_workers=2) as pool:
        result=list(pool.map(lambda engine:candidate_search(query,engine,lead),SITE_ENGINES))
    # Directory labels may abbreviate Offices, merge a suffix, or retain a
    # middle initial absent on the actual site. Search names and exact phone
    # independently of that label. Extra queries are positive-only: they cannot
    # substitute for the two controlled provider checks above.
    ignored={"law","firm","group","office","offices","off","legal","attorney",
             "attorneys","lawyer","lawyers","the","and","llc","llp","pllc","pc"}
    names=[v for v in re.findall(r"[a-z]+",str(lead.get("firm","")).lower())
           if len(v)>=3 and v not in ignored]
    phone=re.sub(r"\D","",str(lead.get("phone","")))[-10:]
    extra_queries=[]
    if names:extra_queries.append(" ".join(names)+" lawyer "+str(lead.get("state","")))
    if len(phone)==10:extra_queries.append('"'+phone[:3]+"-"+phone[3:6]+"-"+phone[6:]+'" lawyer')
    def extra(engine):
        return [searx_engine(term,engine,lead=lead) for term in extra_queries]
    hints=[];hint_attempts=[]
    with ThreadPoolExecutor(max_workers=2) as pool:
        for attempts in pool.map(extra,SITE_ENGINES):
            hint_attempts.extend(attempts)
            for attempt in attempts:hints.extend(attempt['urls'])
    if hints:
        result.append({"provider":"alias_phone_positive_only","responded":False,
                       "urls":list(dict.fromkeys(hints)),"reason":"broader_identity_search","query_attempts":hint_attempts})
    # Source-published custom email domains are a positive ownership hint.
    # Query the domain without the possibly misspelled directory firm label.
    # A missing result never contributes to negative certification.
    free_mail={"gmail.com","yahoo.com","aol.com","outlook.com","hotmail.com",
               "live.com","icloud.com","msn.com","comcast.net","att.net",
               "sbcglobal.net","verizon.net","bellsouth.net","proton.me","protonmail.com"}
    domains=sorted({email.rsplit("@",1)[-1].lower() for email in lead.get("emails",[])
                    if isinstance(email,str) and "@" in email})
    hints=[]
    for domain in domains[:2]:
        if domain in free_mail or not re.fullmatch(r"[a-z0-9-]+(?:\.[a-z0-9-]+)+",domain):
            continue
        response=searx_engine('site:'+domain, SITE_ENGINES[0])
        for url in response["urls"]:
            host=(urlparse(url).hostname or "").lower()
            if host==domain or host.endswith("."+domain):
                hints.append(url)
    if hints:
        result.append({"provider":"published_email_domain_positive_only",
                       "responded":False,"urls":list(dict.fromkeys(hints)),
                       "reason":"attributable_domain_requires_ownership_review"})
    # YaCy is a resource-intensive optional positive-only evidence channel.
    if os.environ.get("OPENLEADS_YACY_ENABLED") == "1":
        result.append(yacy_search(query, lead=lead))
    return result
