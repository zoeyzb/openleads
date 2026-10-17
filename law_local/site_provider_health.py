"""Do not burn 200 source-backed leads on known-broken site-search providers.

Probes with a KNOWN owned-website firm and a published exact phone, requires
both search providers parseable and each finding the known owned domain in returned
results. A success never certifies that any OTHER firm has no website; it only
permits the existing strict two-provider evidence audit to run.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
from urllib.parse import urlparse
from law_local import worker

CONTROL={"firm":"AXS Law Group","phone":"3057030274",
         "city":"Miami","state":"FL"}
KNOWN_DOMAIN="axslawgroup.com"

def audit_provider_health(lookups=None):
    lookups=lookups or worker.search_for_firm
    sources=lookups(CONTROL)
    both_ready=len(sources)>=2 and all(src.get("responded") is True for src in sources[:2])
    details=[]
    for source in sources[:2]:
        found=False
        for raw in source.get("urls",[]):
            try:
                host=(urlparse(worker.search_target(raw)).hostname or "").lower()
            except Exception:
                continue
            if host==KNOWN_DOMAIN or host.endswith("."+KNOWN_DOMAIN):
                found=True
        details.append({"provider":source.get("provider","unknown"),
                        "reason":source.get("reason",""),
                        "http_status":source.get("http_status",0),
                        "retry_after_seconds":source.get("retry_after_seconds",0),
                        "responded":bool(source.get("responded")),
                        "result_count":len(source.get("urls",[])),
                        "positive_control_found":found})
    relevant=len(details)==2 and all(d["positive_control_found"] for d in details)
    return {"status":"usable" if both_ready and relevant else "degraded",
            "responded":sum(bool(s.get("responded")) for s in sources[:2]),
            "positive_control_found":relevant,"provider_details":details,
            "reason":"Each independent provider must answer and find the known owned website"}

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
