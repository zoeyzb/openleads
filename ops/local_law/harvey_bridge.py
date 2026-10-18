"""OpenLeads ↔ Harvey sidecar: free law-office discovery and STRICT firm sync.

The installed vendor code and venv live in ~/lead-workspace/openleads-vendors/harvey.
Harvey's own heartbeat and outbound transport are never started. A missing
OSM website tag is only an UNVERIFIED source hint and never lead eligibility.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

from law_local.worker import SqliteQueue, norm, normalize_phone, utc_now

ROOT = Path.home() / "lead-workspace"
VENDOR = ROOT / "openleads-vendors" / "harvey"
CITIES = {
    "chicago": ("Chicago", "IL", 41.8781, -87.6298),
    "miami": ("Miami", "FL", 25.7617, -80.1918),
    "houston": ("Houston", "TX", 29.7604, -95.3698),
    "atlanta": ("Atlanta", "GA", 33.7490, -84.3880),
    "philadelphia": ("Philadelphia", "PA", 39.9526, -75.1636),
}


def _sidecar_command(task, vendor=VENDOR):
    python = Path(vendor) / ".venv/bin/python"
    script = Path(__file__).with_name("harvey_sidecar.py")
    if not python.is_file() or not script.is_file():
        raise RuntimeError("Harvey sidecar or isolated Python venv not installed")
    return [str(python), str(script), task]


def _environment(vendor=VENDOR):
    # Pass a narrow process environment, not GitHub/Sheets credentials,
    # CloudTalk tokens, existing model API keys or inherited MCP settings.
    permitted=("PATH","HOME","USER","LOGNAME","LANG","LC_ALL",
               "LC_CTYPE","TMPDIR","SHELL","TZ","HTTPS_PROXY",
               "HTTP_PROXY","NO_PROXY","SSL_CERT_FILE","REQUESTS_CA_BUNDLE")
    env={key:os.environ[key] for key in permitted if key in os.environ}
    env["PATH"] = str(Path(vendor)/".harvey-codex-cli/node_modules/.bin") + os.pathsep + env.get("PATH", "/usr/bin:/bin")
    return env


def _run(args, vendor=VENDOR, payload=None, timeout=175):
    result = subprocess.run(args, input=json.dumps(payload) if payload is not None else "",
                            text=True, capture_output=True, cwd=vendor,
                            env=_environment(vendor), timeout=timeout)
    if result.returncode:
        # Return a concise upstream failure rather than paths, tracebacks, or
        # potential headers from a third-party network client.
        matched=re.search(r"HTTPStatusError:[^\n]*?\b([45]\d\d)\b",result.stderr)
        reason=("OSM upstream HTTP "+matched.group(1)) if matched else "isolated Harvey runtime failed"
        raise RuntimeError(reason)
    try:
        value=json.loads(result.stdout.strip().splitlines()[-1])
    except (IndexError,ValueError,TypeError):
        raise RuntimeError("Harvey sidecar returned invalid JSON") from None
    if not isinstance(value,dict):
        raise RuntimeError("Harvey sidecar returned invalid result object")
    return value


def _strict_firms(db_path):
    queue=SqliteQueue(db_path)
    rows=[]
    emails=set()
    try:
        for record,evidence in queue._verified_rows(("strict_eligible",)):
            email=str(evidence.get("email", "")).strip().lower()
            if not email or email in emails:
                continue
            emails.add(email)
            rows.append({
                "id":"openleads:strict:"+hashlib.sha256(normalize_phone(record["phone"]).encode()).hexdigest()[:24],
                "firm":record["firm"], "phone":normalize_phone(record["phone"]),
                "city":record["city"],"state":record["state"],
                "source_url":record["source_url"],
                "email":email,"attorneys":int(evidence.get("attorneys") or 0),
                "headcount_source":evidence.get("headcount_source", ""),
                "email_source":evidence.get("email_source", ""),
                "site_status":evidence.get("site_status", ""),
                "checked_at":evidence.get("checked_at", ""),
                "status":"strict_eligible",
            })
    finally:
        queue.close()
    return rows


def sync_verified(db_path=ROOT/"law-leads.sqlite3",vendor=VENDOR,runner=_run):
    rows=_strict_firms(db_path)
    output=runner(_sidecar_command("sync-strict",vendor)+[
           "--db",str(Path(vendor)/"data/harvey.db")],vendor=vendor,
           payload={"strict_firms":rows},timeout=70)
    if output.get("strict_companies")!=len(rows) or output.get("prospects_created")!=0 or output.get("outbound_enabled") is not False:
        raise RuntimeError("Harvey strict-sync contract violated")
    return {"verified_firms_from_openleads":len(rows),**output}


def _ensure_research(c):
    c.executescript('''CREATE TABLE IF NOT EXISTS harvey_osm_research (
        external_id TEXT PRIMARY KEY,firm TEXT NOT NULL,phone TEXT NOT NULL,
        city TEXT NOT NULL,state TEXT NOT NULL,listed_website TEXT NOT NULL,
        source_url TEXT NOT NULL,category TEXT NOT NULL,
        recorded_at TEXT NOT NULL,disposition TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS harvey_osm_runs (
        city_key TEXT PRIMARY KEY,last_attempt TEXT NOT NULL,
        status TEXT NOT NULL,error TEXT NOT NULL DEFAULT '',
        discovered INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS idx_harvey_osm_disposition ON harvey_osm_research(disposition,recorded_at);
    ''')
    c.commit()


def _validate_osm_source(raw):
    parsed=urlparse(str(raw or ""))
    return (parsed.scheme=="https" and (parsed.hostname or "").lower()=="www.openstreetmap.org"
            and re.fullmatch(r"/(node|way|relation)/[0-9]+",parsed.path) is not None
            and not (parsed.query or parsed.fragment or parsed.username or parsed.password))


def discover_osm(city_key="chicago",research_db=ROOT/"research_catalog.sqlite3",
                 leads_db=ROOT/"law-leads.sqlite3",vendor=VENDOR,runner=_run,
                 force=False,limit=40,now=None):
    if city_key not in CITIES:
        raise ValueError("City must be one of configured U.S. city anchors")
    if not 1 <= int(limit) <= 80:
        raise ValueError("Harvey OSM discovery limit must be 1..80")
    now=now or datetime.now(timezone.utc)
    city,state,lat,lon=CITIES[city_key]
    research=sqlite3.connect(research_db, timeout=30)
    try:
        _ensure_research(research)
        prior=research.execute('SELECT last_attempt,status FROM harvey_osm_runs WHERE city_key=?',(city_key,)).fetchone()
        if prior and not force:
            try:
                timestamp=datetime.fromisoformat(prior[0].replace('Z','+00:00'))
                cooldown=timedelta(days=1) if prior[1]=='ok' else timedelta(hours=6)
                if timestamp.tzinfo is not None and timedelta(0) <= now-timestamp < cooldown:
                    return {"city":city_key,"skipped_recent":True,"research_only":True,
                            "strict_qualified_created":0,"reason":"provider_cooldown"}
            except (ValueError,TypeError):pass
        args=_sidecar_command("discover-osm",vendor)+[
            "--city",city,"--state",state,"--lat",str(lat),"--lon",str(lon),
            "--radius","12","--limit",str(limit)]
        try:
            output=runner(args,vendor=vendor,timeout=175)
            if output.get("provider")!="harvey:osm" or not isinstance(output.get("rows"),list):
                raise RuntimeError("Harvey OSM provider response invalid")
            rows=output["rows"]
            if len(rows)>int(limit):
                raise RuntimeError("Harvey OSM output exceeded request cap")
        except Exception as exc:
            research.execute('''INSERT INTO harvey_osm_runs VALUES (?,?,?,?,?)
               ON CONFLICT(city_key) DO UPDATE SET last_attempt=excluded.last_attempt,
               status=excluded.status,error=excluded.error''',
               (city_key,now.isoformat(timespec="seconds"),'failed',type(exc).__name__,0))
            research.commit()
            return {"city":city_key,"error":type(exc).__name__,"reason":str(exc)[:170],
                    "research_only":True,"strict_qualified_created":0}
        seen=added=without_field=had_field=filtered=0
        leads=sqlite3.connect(leads_db,timeout=30)
        try:
            # Reuse the existing unverified map-identity pool. An OSM listing
            # without a website field is NEVER website-absence confirmation.
            leads.execute('''CREATE TABLE IF NOT EXISTS maps_raw_candidates (
               map_id TEXT PRIMARY KEY,firm TEXT NOT NULL,phone TEXT NOT NULL,
               state TEXT NOT NULL,maps_url TEXT NOT NULL,added_at TEXT NOT NULL,
               status TEXT NOT NULL DEFAULT 'unverified_headcount',city TEXT NOT NULL DEFAULT '')''')
            for item in rows:
                if not isinstance(item,dict) or not _validate_osm_source(item.get("source_url")):
                    filtered+=1
                    continue
                firm=str(item.get("name") or "").strip()
                phone=normalize_phone(item.get("phone"))
                website=str(item.get("website") or "").strip()
                has_website=item.get("has_website")
                if not firm or not phone or item.get("category")!="lawyer" or not isinstance(has_website,bool):
                    filtered+=1
                    continue
                ext=f"osm:{urlparse(item['source_url']).path.lstrip('/')}"
                if item.get("external_id")!=ext:
                    filtered+=1
                    continue
                disposition="listed_website_hold" if website or has_website else "no_listed_website_only"
                # A later blank OSM website field cannot erase earlier
                # positive website evidence for this same immutable OSM id.
                older=research.execute('SELECT listed_website,disposition FROM harvey_osm_research WHERE external_id=?', (ext,)).fetchone()
                if older and older[1]=='listed_website_hold':
                    disposition='listed_website_hold'
                    website=website or older[0]
                research.execute('''INSERT INTO harvey_osm_research
                    (external_id,firm,phone,city,state,listed_website,source_url,category,recorded_at,disposition)
                    VALUES (?,?,?,?,?,?,?,?,?,?)
                    ON CONFLICT(external_id) DO UPDATE SET
                    firm=excluded.firm,phone=excluded.phone,city=excluded.city,state=excluded.state,
                    listed_website=excluded.listed_website,source_url=excluded.source_url,
                    recorded_at=excluded.recorded_at,disposition=excluded.disposition''',
                    (ext,firm,phone,city,state,website,item["source_url"],"lawyer",
                     now.isoformat(timespec="seconds"),disposition))
                seen+=1
                if disposition=="listed_website_hold":
                    had_field+=1
                    continue
                without_field+=1
                identity=norm(firm)+"|"+phone
                added+=int(leads.execute('''INSERT OR IGNORE INTO maps_raw_candidates
                    (map_id,firm,phone,state,maps_url,added_at,status,city)
                    VALUES (?,?,?,?,?,?,?,?)''',
                    (identity,firm,phone,state,item["source_url"],now.isoformat(timespec="seconds"),
                    "unverified_headcount",city)).rowcount>0)
            leads.commit()
            research.execute('''INSERT INTO harvey_osm_runs VALUES(?,?,?,?,?)
               ON CONFLICT(city_key) DO UPDATE SET last_attempt=excluded.last_attempt,
               status=excluded.status,error=excluded.error,discovered=excluded.discovered''',
               (city_key,now.isoformat(timespec="seconds"),'ok','',seen))
            research.commit()
        finally:leads.close()
        return {"city":city_key,"provider":"harvey:osm","discovered_with_valid_law_phone":seen,
                "source_has_website":had_field,"no_website_field_only":without_field,
                "new_unverified_map_research":added,"skipped_invalid":filtered,
                "strict_qualified_created":0,"research_only":True}
    finally:research.close()


def doctor(vendor=VENDOR,runner=subprocess.run):
    cli=Path(vendor)/".venv/bin/harvey"
    codex=Path(vendor)/".harvey-codex-cli/node_modules/.bin/codex"
    if not cli.exists() or not codex.exists():
        return {"installed":False,"codex_connected":False,"reason":"isolated Harvey/Codex missing"}
    result=runner([str(cli),"status","--check"],cwd=vendor,
                  env=_environment(vendor),capture_output=True,text=True,timeout=85)
    output=result.stdout+result.stderr
    # Never return credential/token output; only a preflight success and
    # short, human-safe reason. Auth refresh is always user-controlled.
    if result.returncode==0 and " ready (CLI, isolation, login, model and account checked" in output:
        return {"installed":True,"codex_connected":True,"outbound_enabled":False}
    if "expired or is due for renewal" in output:
        reason="ChatGPT Codex login expired; operator must reauthenticate"
    elif "Codex NOT READY" in output:
        reason="Codex CLI preflight did not pass; run Harvey status --check"
    else:
        reason="Harvey/Codex preflight incomplete"
    return {"installed":True,"codex_connected":False,"outbound_enabled":False,"reason":reason}


def main():
    p=argparse.ArgumentParser(description="OpenLeads Harvey adapter; no email sending")
    cmd=p.add_subparsers(dest="command",required=True)
    cmd.add_parser("doctor")
    cmd.add_parser("sync-strict")
    osm=cmd.add_parser("discover-osm")
    osm.add_argument("--city",choices=sorted(CITIES),default="chicago")
    osm.add_argument("--max",type=int,default=40)
    osm.add_argument("--force",action="store_true")
    args=p.parse_args()
    if args.command=="doctor":result=doctor()
    elif args.command=="sync-strict":result=sync_verified()
    else:result=discover_osm(args.city,force=args.force,limit=args.max)
    print(json.dumps(result,sort_keys=True))

if __name__=="__main__":main()
