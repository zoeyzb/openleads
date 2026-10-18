"""Opt-in localhost search adapters. Third-party results are evidence, not proof of no website.

SearXNG issues *separate* Yandex and Yep engine requests; neither the wrapper
nor a responsive HTTP status alone establishes an independent negative search.
YaCy uses its own P2P index for positive hints only: low coverage never qualifies.
"""
from __future__ import annotations
import json
import os
import re
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

ALLOWED_HOSTS = {"127.0.0.1", "localhost"}
MAX_RESPONSE = 1024 * 1024
# Two independently indexed public-web search engines; each must recover
# known owned websites in live controls. No provider is treated as unlimited.
SITE_ENGINES = ('yandex', 'yep')
SITE_PROVIDERS = tuple('searxng:' + e for e in SITE_ENGINES)
LEGACY_SITE_PROVIDERS = ('searxng:google cse', 'searxng:yahoo')

def valid_provider_pair(results, legacy=False):
    if len(results) < 2:
        return False
    actual = tuple(item.get('provider') for item in results[:2])
    return actual == SITE_PROVIDERS or (legacy and actual == LEGACY_SITE_PROVIDERS)



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
    ignored = {"law", "firm", "group", "office", "legal", "attorney", "attorneys", "lawyer", "lawyers", "the", "and", "llc", "llp", "pllc", "pc"}
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
            if not distinctive:
                continue
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
            if not direct_firm_domain and not all(token in words for token in distinctive):
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
    output = {"provider": "searxng:" + engine, "responded": False, "urls": [], "reason": "unavailable"}
    try:
        url = local_origin(origin or os.environ.get("OPENLEADS_SEARXNG_URL", "http://127.0.0.1:18888"), 18888)
        payload = _read_json(url + "/search?" + urlencode({"q": query, "format": "json", "engines": engine, "language": "en-US"}), fetch)
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
        # A local HTTP 200 with no attributable firm-matching hits is not
        # evidence of a completed negative website search. This matters when
        # SearXNG silently falls back to other engines or a parser breaks.
        output["responded"] = bool(output["urls"])
        output["reason"] = "results" if output["urls"] else "empty_or_unattributed"
    except (ValueError, OSError, TimeoutError, TypeError, json.JSONDecodeError) as exc:
        output["reason"] = type(exc).__name__
    return output


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
    # Yandex and Yep independently recovered AXS Law Group, Baker McKenzie,
    # and Olsen & White on 2026-10-17. Continue to fail closed on outages.
    # Bounded independent requests in parallel preserve provider order while
    # reducing a two-provider outage from ~16s to ~8s per firm.
    with ThreadPoolExecutor(max_workers=2) as pool:
        result=list(pool.map(lambda engine:searx_engine(query,engine,lead=lead),SITE_ENGINES))
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
