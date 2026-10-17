"""Opt-in localhost search adapters. Third-party results are evidence, not proof of no website.

SearXNG issues *separate* Google and Bing engine requests; neither the wrapper
nor a responsive HTTP status alone establishes an independent negative search.
YaCy uses its own P2P index for positive hints only: low coverage never qualifies.
"""
from __future__ import annotations
import json
import os
import re
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

ALLOWED_HOSTS = {"127.0.0.1", "localhost"}
MAX_RESPONSE = 1024 * 1024


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
            if not all(token in words for token in distinctive):
                continue
        result.append(link)
    return list(dict.fromkeys(result))[:15]


def searx_engine(query, engine, origin=None, fetch=None, lead=None):
    if engine not in ("google", "bing"):
        raise ValueError("only separate named search engine requests are supported")
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
        output["responded"] = True
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
    result = [searx_engine(query, "google", lead=lead), searx_engine(query, "bing", lead=lead)]
    # YaCy is a resource-intensive optional positive-only evidence channel.
    if os.environ.get("OPENLEADS_YACY_ENABLED") == "1":
        result.append(yacy_search(query, lead=lead))
    return result
