"""Bounded, resumable research-only website discovery from self-hosted search.

Reads existing Google Maps research rows, probes two named independent engines,
and saves dated search observations to private research SQLite. Neither a hit
nor two index negatives qualifies a practice without separate identity,
phone, attorney-count, published-email and ownership review.
"""
from __future__ import annotations
import argparse
import json
import sqlite3
from datetime import datetime, timezone, timedelta
from pathlib import Path
from law_local.worker import classify_search_results, normalize_phone, utc_now
from law_local.free_search import search_firm
from law_local.site_provider_health import audit_provider_health

ROOT = Path.home() / 'lead-workspace'


def ensure(conn):
    conn.execute('''CREATE TABLE IF NOT EXISTS local_selfhosted_site_checks (
        map_id TEXT PRIMARY KEY, firm TEXT NOT NULL, phone TEXT NOT NULL,
        checked_at TEXT NOT NULL, status TEXT NOT NULL,
        evidence_json TEXT NOT NULL)''')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_local_selfhosted_status ON local_selfhosted_site_checks(status,checked_at)')
    conn.commit()


def recent(record, now):
    if record is None:
        return False
    try:
        checked = datetime.fromisoformat(record['checked_at'].replace('Z','+00:00'))
        if checked.tzinfo is None: return False
        age=now-checked
        ttl=timedelta(hours=6) if record['status']=='inconclusive' else timedelta(days=7)
        return timedelta(0) <= age <= ttl
    except (ValueError,TypeError):
        return False


def pilot(root=ROOT, maximum=4, search=search_firm, health=None, now=None):
    maximum=int(maximum)
    if not (1<=maximum<=12): raise ValueError('pilot maximum must be 1–12')
    root=Path(root)
    now=now or datetime.now(timezone.utc)
    report={'attempted':0,'review_website':0,'screened_no_site':0,
            'inconclusive':0,'calling_qualified_added':0,'skipped_recent':0,
            'skipped_duplicate_phone':0,'provider_status':'unknown'}
    checks=health if health is not None else lambda: audit_provider_health(lookups=search)
    provider=checks()
    report['provider_status']=provider.get('status','unknown')
    if provider.get('status')!='usable' or not provider.get('positive_control_found'):
        return dict(report,reason='known_owned_site_positive_control_failed')
    leads=sqlite3.connect(root/'law-leads.sqlite3',timeout=10)
    catalog=sqlite3.connect(root/'research_catalog.sqlite3',timeout=10)
    catalog.row_factory=sqlite3.Row
    try:
        ensure(catalog)
        # Read from existing research-only Maps pool, not qualification queue.
        source=leads.execute('''SELECT map_id,firm,phone,city,state,maps_url FROM maps_raw_candidates
            WHERE status='unverified_headcount' AND trim(city) != '' AND trim(state) != ''
            ORDER BY CASE
                WHEN lower(firm) LIKE '%law group%' OR lower(firm) LIKE '%partners%'
                  OR lower(firm) LIKE '%llp%' OR lower(firm) LIKE '%pllc%' THEN 0
                WHEN lower(firm) LIKE '%law%' OR lower(firm) LIKE '%attorney%' THEN 1
                ELSE 2 END,
                added_at,map_id''')
        # The same practice/phone may appear several times in Maps or already
        # be an accepted calling row. Do not spend requests on those duplicates.
        prior_qualified={normalize_phone(row[0]) for row in leads.execute(
            "SELECT phone FROM candidates WHERE status IN ('strict_eligible','call_qualified_no_email')")}
        seen=set(prior_qualified)
        for map_id,firm,phone,city,state,maps_url in source:
            phone=normalize_phone(phone)
            if not phone or phone in seen:
                report['skipped_duplicate_phone']+=1
                continue
            seen.add(phone)
            old=catalog.execute('SELECT checked_at,status FROM local_selfhosted_site_checks WHERE map_id=?',(map_id,)).fetchone()
            if recent(old,now):
                report['skipped_recent']+=1
                continue
            lead={'firm':firm,'phone':phone,'city':city,'state':state,'source_url':maps_url}
            try:
                results=search(lead)
                # The first two providers must be the exact probed engines.
                if len(results)<2 or [v.get('provider') for v in results[:2]] != ['searxng:google cse','searxng:yahoo']:
                    raise ValueError('unexpected_search_providers')
                signal=classify_search_results(results)
                evidence={'checked_at':utc_now(), 'search_providers':results,
                          'site_signal':signal, 'qualification':'RESEARCH_ONLY'}
                status=signal['status']
            except (OSError,ValueError,TypeError,KeyError) as exc:
                status='inconclusive'
                evidence={'checked_at':utc_now(),'status':status,'reason':type(exc).__name__,'qualification':'RESEARCH_ONLY'}
            if status not in ('review_website','screened_no_site','inconclusive'):
                status='inconclusive'
            catalog.execute('''INSERT INTO local_selfhosted_site_checks
                (map_id,firm,phone,checked_at,status,evidence_json)
                VALUES(?,?,?,?,?,?)
                ON CONFLICT(map_id) DO UPDATE SET
                firm=excluded.firm,phone=excluded.phone,checked_at=excluded.checked_at,
                status=excluded.status,evidence_json=excluded.evidence_json''',
                (map_id,firm,phone,now.isoformat(timespec='seconds'),status,json.dumps(evidence,sort_keys=True)))
            catalog.commit()
            report['attempted']+=1
            report[status]+=1
            if report['attempted']>=maximum:break
        report['total_stored']=catalog.execute('SELECT COUNT(*) FROM local_selfhosted_site_checks').fetchone()[0]
        return report
    finally:
        catalog.close();leads.close()


def reclassify(root=ROOT, maximum=1000):
    """Re-evaluate cached research without network requests or caller changes."""
    if not (1 <= int(maximum) <= 10000):
        raise ValueError('reclassification limit must be 1–10000')
    catalog = sqlite3.connect(Path(root) / 'research_catalog.sqlite3', timeout=10)
    catalog.row_factory = sqlite3.Row
    try:
        ensure(catalog)
        catalog.execute("""CREATE TABLE IF NOT EXISTS local_selfhosted_reclass_history (
            map_id TEXT NOT NULL, reclassified_at TEXT NOT NULL,
            old_status TEXT NOT NULL, new_status TEXT NOT NULL,
            old_site_signal TEXT NOT NULL, new_site_signal TEXT NOT NULL)""")
        report = {'inspected': 0, 'changed': 0, 'to_screened_no_site': 0,
                  'calling_qualified_added': 0}
        rows = catalog.execute("""SELECT map_id,status,evidence_json
            FROM local_selfhosted_site_checks ORDER BY checked_at,map_id LIMIT ?""",
                               (int(maximum),)).fetchall()
        for row in rows:
            try:
                record = json.loads(row['evidence_json'])
                sources = record.get('search_providers', [])
                if (len(sources) < 2 or
                    [v.get('provider') for v in sources[:2]] !=
                        ['searxng:google cse', 'searxng:yahoo']):
                    continue
                updated = classify_search_results(sources)
                if updated['status'] not in ('review_website','screened_no_site','inconclusive'):
                    continue
                report['inspected'] += 1
                if updated['status'] == row['status']:
                    continue
                previous = record.get('site_signal', {})
                catalog.execute("""INSERT INTO local_selfhosted_reclass_history
                    (map_id,reclassified_at,old_status,new_status,old_site_signal,new_site_signal)
                    VALUES(?,?,?,?,?,?)""", (row['map_id'],utc_now(),row['status'],
                    updated['status'],json.dumps(previous,sort_keys=True),
                    json.dumps(updated,sort_keys=True)))
                record['site_signal'] = updated
                record['reclassified_at'] = utc_now()
                catalog.execute("""UPDATE local_selfhosted_site_checks
                    SET status=?,evidence_json=? WHERE map_id=?""",
                    (updated['status'],json.dumps(record,sort_keys=True),row['map_id']))
                report['changed'] += 1
                if updated['status'] == 'screened_no_site':
                    report['to_screened_no_site'] += 1
            except (ValueError, TypeError, KeyError, IndexError):
                continue
        catalog.commit()
        return report
    finally:
        catalog.close()


def main():
    p=argparse.ArgumentParser(description='Locally-hosted, research-only law website search pilot')
    p.add_argument('--max',type=int,default=4)
    p.add_argument('--root',type=Path,default=ROOT)
    p.add_argument('--reclassify',action='store_true',help='Re-evaluate cached URLs offline after directory rules change')
    args=p.parse_args()
    output=reclassify(args.root) if args.reclassify else pilot(args.root,args.max)
    print(json.dumps(output,indent=2))
if __name__=='__main__':main()
