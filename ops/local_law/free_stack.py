"""Fork registry and bounded diagnostic CLI for free OpenLeads integrations.

External search/crawl systems are independently operated and optional. Their
research observations cannot add qualified calling leads through this module.
"""
from __future__ import annotations
import argparse
import importlib.util
import json
import os
import shutil
import subprocess
from pathlib import Path
from urllib.request import urlopen

FORKS = {
    "searxng": {"repo": "https://github.com/zoeyzb/searxng", "role": "two explicit upstream engine searches", "kind": "website_search"},
    "yacy": {"repo": "https://github.com/zoeyzb/yacy_search_server", "role": "independent-index owned-site hints", "kind": "positive_only"},
    "maps": {"repo": "https://github.com/zoeyzb/google-maps-scraper", "role": "existing localhost business/phone discovery", "kind": "research_only"},
    "stormcrawler": {"repo": "https://github.com/zoeyzb/stormcrawler", "role": "optional offline large-scale crawl, Java 25+ required", "kind": "disabled_by_default"},
    "cdx_toolkit": {"repo": "https://github.com/zoeyzb/cdx_toolkit", "role": "optional archival URL lookup", "kind": "historical_positive_only"},
}


def installed_java_major(runner=subprocess.run):
    try:
        result = runner(["java", "-version"], capture_output=True, text=True, timeout=4)
        import re
        match = re.search(r'"(\d+)(?:\.|"|\+)', result.stderr + result.stdout)
        return int(match.group(1)) if result.returncode == 0 and match else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def status():
    from law_local import free_search
    out = {}
    fork_root = Path(os.environ.get('OPENLEADS_FORKS_DIR', str(Path.home()/'lead-workspace/openleads-forks')))
    for key, spec in FORKS.items():
        out[key] = dict(spec)
        dirname = 'google-maps-scraper' if key == 'maps' else ('yacy_search_server' if key == 'yacy' else key)
        checkout = fork_root / dirname
        out[key]['fork_checked_out'] = (checkout/'.git').is_dir()
        out[key]['fork_path'] = str(checkout) if out[key]['fork_checked_out'] else ''
    out['searxng']['configured'] = os.environ.get('OPENLEADS_SEARCH_MODE') == 'local_forks'
    out['searxng']['origin'] = free_search.local_origin(os.environ.get('OPENLEADS_SEARXNG_URL', 'http://127.0.0.1:18888'), 18888)
    out['yacy']['origin'] = free_search.local_origin(os.environ.get('OPENLEADS_YACY_URL', 'http://127.0.0.1:18090'), 18090)
    out['maps']['collector'] = 'http://127.0.0.1:18080 (existing import + job scheduler)'
    out['cdx_toolkit']['installed'] = importlib.util.find_spec('cdx_toolkit') is not None
    out['cdx_toolkit']['optional_venv'] = str(fork_root/'.venv/bin/python')
    out['cdx_toolkit']['existing_commoncrawl_adapter'] = 'ops.local_law.commoncrawl_profiles'
    out['stormcrawler']['java_major'] = installed_java_major()
    out['stormcrawler']['ready_for_build'] = (out['stormcrawler']['java_major'] or 0) >= 25 and bool(shutil.which('mvn'))
    out['safety'] = 'Research or owned-site hints only; no automatic calling qualification without independent completed checks'
    return out


def probe():
    """Only probes the named known-owned-site control, never consumes candidate budgets."""
    from law_local import free_search
    from law_local.site_provider_health import audit_provider_health
    original = os.environ.get('OPENLEADS_SEARCH_MODE')
    os.environ['OPENLEADS_SEARCH_MODE'] = 'local_forks'
    try:
        health = audit_provider_health()
        # YaCy is positive-only and not treated as a second negative source.
        return {'search': health, 'known_site_control': 'AXS Law Group / axslawgroup.com',
                'qualification_gate': 'usable' if health['status'] == 'usable' else 'blocked',
                'warning': 'Passing one control does not establish nationwide negative-search coverage'}
    finally:
        if original is None: os.environ.pop('OPENLEADS_SEARCH_MODE', None)
        else: os.environ['OPENLEADS_SEARCH_MODE'] = original


def inspect(firm, city='', state=''):
    from law_local.free_search import search_firm
    from law_local.worker import classify_search_results
    observations = search_firm({'firm': firm, 'city': city, 'state': state})
    classification = classify_search_results(observations)
    return {'firm': firm, 'observations': observations, 'site_signal': classification,
            'calling_qualified_added': 0, 'note': 'Research only. Evidence and active-practice validation required before import.'}


def cdx_hints(pattern, limit=10):
    """Optional cdx_toolkit from the fork. Historical URLs cannot clear sites."""
    if importlib.util.find_spec('cdx_toolkit') is None:
        return {'status': 'not_installed', 'install': 'python3 -m pip install -e ~/lead-workspace/openleads-forks/cdx_toolkit', 'urls': []}
    import cdx_toolkit
    if not pattern or '/' not in pattern or ' ' in pattern or len(pattern) > 200:
        raise ValueError('Expected bounded public-domain URL pattern, e.g. lawyer.com/firm/example*')
    cdx = cdx_toolkit.CDXFetcher(source='cc')
    hits=[]
    for hit in cdx.iter(pattern, limit=min(int(limit), 20)):
        url=hit.get('url')
        if url and hit.get('status') == '200':
            hits.append({'url':url, 'timestamp':hit.get('timestamp')})
    return {'status':'historical_hints_only', 'urls':hits, 'calling_qualified_added':0}


def main():
    cli=argparse.ArgumentParser(description='Free fork integrations; research-only until independent verification')
    sub=cli.add_subparsers(dest='action',required=True)
    sub.add_parser('status')
    sub.add_parser('probe')
    p=sub.add_parser('inspect');p.add_argument('firm');p.add_argument('--city',default='');p.add_argument('--state',default='')
    p=sub.add_parser('cdx-hints');p.add_argument('pattern');p.add_argument('--limit',type=int,default=10)
    args=cli.parse_args()
    if args.action=='status': result=status()
    elif args.action=='probe':result=probe()
    elif args.action=='inspect':result=inspect(args.firm,args.city,args.state)
    else:result=cdx_hints(args.pattern,args.limit)
    print(json.dumps(result,indent=2))
if __name__=='__main__':main()
