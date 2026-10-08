"""Do not burn 200 source-backed leads on known-broken site-search providers.

Probes with a KNOWN owned-website firm and a published exact phone, requires
both search providers parseable and at least one known owned domain in returned
results. A success never certifies that any OTHER firm has no website; it only
permits the existing strict two-provider evidence audit to run.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
from urllib.parse import urlparse
from law_local import worker

CONTROL={"firm":"Culmer & Davidson","phone":"3216382002",
         "city":"Rockledge","state":"FL"}
KNOWN_DOMAIN="brevardtrialattorneys.com"

def audit_provider_health(lookups=None):
    lookups=lookups or worker.search_for_firm
    sources=lookups(CONTROL)
    both_ready=len(sources)>=2 and all(src.get("responded") is True for src in sources[:2])
    relevant=False
    if both_ready:
        for s in sources[:2]:
            for raw in s.get("urls",[]):
                try:
                    host=(urlparse(worker.search_target(raw)).hostname or "").lower()
                except Exception:
                    continue
                if host==KNOWN_DOMAIN or host.endswith("."+KNOWN_DOMAIN):
                    relevant=True
    return {"status":"usable" if both_ready and relevant else "degraded",
            "responded":sum(bool(s.get("responded")) for s in sources[:2]),
            "positive_control_found":bool(relevant),
            "reason":"site searches are not usable for strict negative evidence unless both answer and find a known positive site"}

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--ready-flag",default="state/website-search-ready.flag")
    args=p.parse_args()
    flag=Path(args.ready_flag)
    flag.unlink(missing_ok=True)
    result=audit_provider_health()
    if result["status"]=="usable":
        flag.parent.mkdir(parents=True,exist_ok=True)
        flag.write_text("probed "+worker.utc_now()+"\n")
    print(json.dumps({"website_search_provider_health":result}),flush=True)

if __name__=="__main__":
    main()
