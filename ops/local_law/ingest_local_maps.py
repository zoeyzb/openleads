"""Ingest a completed localhost-only Gosom job into the original law research queue.

No website/firm-size qualification is implied by a missing Maps site field.
Idempotent by saved output path and normalized firm+phone Maps candidate ID.
"""
from __future__ import annotations
import argparse,json,urllib.request
from pathlib import Path
from law_local.maps_extract import extract
from law_local.maps_first import ingest_maps_candidates
from law_local.worker import SqliteQueue
HOST='http://127.0.0.1:18080'

def ingest(job_id,root=None,api=HOST):
    root=Path(root or Path.home()/'lead-workspace')
    if not (isinstance(job_id,str) and len(job_id)==36 and all(c in 'abcdef0123456789-' for c in job_id.lower())):
        raise ValueError('Expected a real UUID job ID')
    base=api.rstrip('/')
    if base!=HOST:
        raise ValueError('Only the explicitly configured local collector is allowed')
    with urllib.request.urlopen(f'{base}/api/v1/jobs/{job_id}',timeout=12) as response:
        job=json.load(response)
    status=str(job.get('Status','')).lower()
    if status not in ('ok','done','completed','success','finished'):
        return {'job_id':job_id,'status':status,'ingested':False}
    mapsdir=root/'local-maps-data'/'imports';mapsdir.mkdir(parents=True,exist_ok=True)
    raw=mapsdir/f'{job_id}-raw.csv'
    if not raw.exists():
        with urllib.request.urlopen(f'{base}/api/v1/jobs/{job_id}/download',timeout=30) as response:
            content=response.read(20000000)
        if not content or b',' not in content[:500]:raise ValueError('Maps job CSV empty or invalid')
        raw.write_bytes(content)
    cleaned=mapsdir/f'{job_id}-research-only.csv'
    result=extract(raw,cleaned)
    db=SqliteQueue(root/'law-leads.sqlite3')
    try: added=ingest_maps_candidates(db,cleaned)
    finally:db.close()
    return {'job_id':job_id,'status':status,'raw_listings':result['raw_rows'],
            'maps_no_site_phone_candidates':result['maps_no_site_phone_candidates'],
            'new_unverified_queue_rows':added,'qualified_calling_leads_created':0,
            'ingested':True,'private_csv':str(cleaned)}

def main():
    p=argparse.ArgumentParser();p.add_argument('--job-file',default=str(Path.home()/'lead-workspace/local-maps-pilot-job.json'))
    args=p.parse_args();job=json.loads(Path(args.job_file).read_text())
    print(json.dumps(ingest(job['id'])))
if __name__=='__main__':main()
