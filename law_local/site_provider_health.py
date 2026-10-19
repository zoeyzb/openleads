"""Do not burn 200 source-backed leads on known-broken site-search providers.

Probes with a KNOWN owned-website firm and a published exact phone, requires
both search providers parseable and each finding the known owned domain in returned
results. A success never certifies that any OTHER firm has no website; it only
permits the existing strict two-provider evidence audit to run.
"""
from __future__ import annotations
import argparse
import json
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse
from law_local import worker

CONTROL={"firm":"AXS Law Group","phone":"3057030274",
         "city":"Miami","state":"FL"}
KNOWN_DOMAIN="axslawgroup.com"

def control_sources(control):
    # Controls need the exact known-site query, not every positive-only alias
    # query used for ownership review. Avoid redundant free-engine requests.
    import os
    if os.environ.get('OPENLEADS_SEARCH_MODE')!='local_forks':
        return worker.search_for_firm(control)
    from concurrent.futures import ThreadPoolExecutor
    from law_local.free_search import candidate_search,SITE_ENGINES
    query='"'+control['firm']+'" law firm '+control['city']+' '+control['state']
    with ThreadPoolExecutor(max_workers=2) as pool:
        return list(pool.map(lambda engine:candidate_search(query,engine,control),SITE_ENGINES))

def bounded_sources(seconds=20):
    """Hard wall clock limit, including HTTP body reads; kill/reap on timeout.

    An independent Python entrypoint also works from interactive/stdin callers,
    unlike multiprocessing spawn which tries to reload a nonexistent <stdin>.
    """
    code="import json; from law_local.site_provider_health import CONTROL,control_sources; print(json.dumps(control_sources(CONTROL)))"
    try:
        result=subprocess.run([sys.executable,"-c",code],
            cwd=Path(__file__).resolve().parents[1],capture_output=True,text=True,
            timeout=max(0.001,float(seconds)),check=False)
        return json.loads(result.stdout) if result.returncode==0 else []
    except subprocess.TimeoutExpired:
        return [{"provider":"preflight","responded":False,"urls":[],
                 "reason":"wall_clock_timeout"}]
    except (ValueError,OSError):
        return []

def audit_provider_health(lookups=None):
    sources=lookups(CONTROL) if lookups is not None else bounded_sources()
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
