"""Thin, private adapter to the installed Harvey *library* in its own venv.

This is executed with the separate Harvey venv's Python. Harvey's heartbeat,
outbox, and email sending are NEVER launched from OpenLeads. An OSM listing
with no website tag stays unverified; only existing strict OpenLeads records
may be mirrored as companies, without inventing human contacts.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path


def _read_bounded_json():
    raw = sys.stdin.buffer.read(1_000_001)
    if len(raw) > 1_000_000:
        raise ValueError("request too large")
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        raise ValueError("expected JSON object")
    return payload


def parse_osm_map_xml(data,city,state,limit):
    """Parse one tiny official OpenStreetMap bbox into research-only hints.

    The OSM editing API returns map geometry rather than a business directory.
    Keep only physically tagged office=lawyer features. Empty website tags
    never establish the absence of a firm-owned domain.
    """
    import xml.etree.ElementTree as ET
    if len(data)>12_000_000:
        raise ValueError("OSM map response too large")
    root=ET.fromstring(data)
    if root.tag!="osm":
        raise ValueError("not an OSM map document")
    rows=[]
    for element in root:
        if element.tag not in ("node","way","relation"):
            continue
        tags={tag.attrib.get("k"):tag.attrib.get("v","") for tag in element.findall("tag")}
        if tags.get("office")!="lawyer" or not tags.get("name"):
            continue
        source_id=element.attrib.get("id","")
        if not source_id.isdecimal() or len(source_id)>20:
            continue
        url=f"https://www.openstreetmap.org/{element.tag}/{source_id}"
        website=tags.get("website") or tags.get("contact:website") or ""
        rows.append({
            "name":tags["name"],"phone":tags.get("phone") or tags.get("contact:phone") or "",
            "website":website,"has_website":bool(website),
            "source_url":url,"external_id":f"osm:{element.tag}/{source_id}",
            "category":"lawyer","address":" ".join(x for x in
                (tags.get("addr:housenumber",""),tags.get("addr:street","")) if x),
            "city":city,"state":state,
        })
        if len(rows)>=limit:
            break
    return rows


async def official_osm_bbox(client,args):
    """One small OpenStreetMap map API request, never a citywide scrape."""
    lat=float(args.lat);lon=float(args.lon)
    bbox=",".join(f"{x:.5f}" for x in
                  (lon-0.005,lat-0.005,lon+0.005,lat+0.005))
    async with client.stream(
        "GET","https://api.openstreetmap.org/api/0.6/map",
        params={"bbox":bbox},
        headers={"Accept":"application/xml",
            "User-Agent":"OpenLeads-Law-Evidence/1.0 (+https://github.com/zoeyzb/openleads)"}) as response:
        response.raise_for_status()
        chunks=[];total=0
        async for chunk in response.aiter_bytes():
            total+=len(chunk)
            if total>12_000_000:
                raise ValueError("OSM map response too large")
            chunks.append(chunk)
    return parse_osm_map_xml(b"".join(chunks),args.city,args.state,args.limit)


async def discover_osm(args):
    import httpx
    from harvey.collectors.discover import OpenStreetMap, DiscoveryQuery, TIMEOUT

    if args.limit < 1 or args.limit > 80 or args.radius < 1 or args.radius > 25:
        raise ValueError("bounded OSM requests require limit 1..80 and radius 1..25 km")
    if not -90 <= args.lat <= 90 or not -180 <= args.lon <= 180:
        raise ValueError("invalid geographic coordinates")
    query = DiscoveryQuery(
        term="lawyer", location=f"{args.city}, {args.state}",
        coordinate=f"{args.lat},{args.lon},{args.radius}", limit=args.limit,
    )
    # Reuse Harvey's real OSM adapter, tag mapping, mirror failover and backoff;
    # no API key, paid discovery source, or LLM call.
    provider = OpenStreetMap()
    # The shipped public endpoints returned HTTP 406/500 during live testing.
    # This community mirror sporadically returned HTTP 200 on small probes,
    # but full live requests still returned HTTP 500. Thus automatic OSM
    # discovery remains DISABLED pending a successful full run. A provider
    # error is never proof that a firm lacks a website.
    provider.ENDPOINTS = ("https://overpass.private.coffee/api/interpreter",)

    class FormEncodedOverpassClient(httpx.AsyncClient):
        async def post(self, url, *, content=None, **kwargs):
            # Harvey sends raw QL bytes, but the reachable community Overpass
            # instance expects `data=<urlencoded OverpassQL>`. Live probes
            # measured HTTP 500 for the raw request and HTTP 200 for form
            # encoding; adapt transport while preserving Harvey's source
            # tagging, response parsing and throttle logic.
            if content is not None and url in provider.ENDPOINTS:
                body=content.decode('utf-8') if isinstance(content,bytes) else str(content)
                return await super().post(url,data={'data':body},**kwargs)
            return await super().post(url,content=content,**kwargs)

    async with FormEncodedOverpassClient(timeout=TIMEOUT, follow_redirects=True) as client:
        try:
            found=await provider.fetch(client,{},query)
        except (httpx.HTTPError,RuntimeError,ValueError):
            # Volunteer Overpass servers currently return 406/500 from the
            # authorized Mac. The primary OSM API supports *small bbox map*
            # downloads. Never issue a broad city/country scrape here.
            rows=await official_osm_bbox(client,args)
            return {"provider":"harvey:osm","transport":"osm_public_api_bbox",
                    "found":len(rows),"rows":rows,"strict_qualified_added":0}
    rows = []
    for item in found[:args.limit]:
        rows.append({
            "name": item.name, "phone": item.phone,
            "website": item.website, "has_website": item.has_website,
            "source_url": item.source_url, "external_id": item.external_id,
            "category": item.category, "address": item.address,
            "city": args.city, "state": args.state,
        })
    return {"provider": "harvey:osm", "transport":"overpass", "found": len(rows), "rows": rows,
            "strict_qualified_added": 0}


async def sync_strict(args):
    from harvey.config import load_config
    from harvey.models.company import Company
    from harvey.state import StateManager

    config = load_config()
    if (config.brain.provider != "codex" or config.channels.email.enabled
            or config.channels.linkedin.enabled or config.channels.email.max_daily_sends != 0):
        raise ValueError("Harvey must remain Codex-configured and outbound-disabled")
    data = _read_bounded_json()
    rows = data.get("strict_firms")
    if not isinstance(rows, list) or len(rows) > 100_000:
        raise ValueError("expected bounded verified firm list")
    destination=Path(args.db)
    destination.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    state = StateManager(db_path=args.db)
    await state.init_db()
    os.chmod(destination,0o600)
    if destination.parent.name=='data':
        os.chmod(destination.parent,0o700)
    valid = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("bad firm row")
        if (row.get("status") != "strict_eligible" or row.get("site_status") != "screened_no_site"
                or not row.get("email") or "@" not in row["email"]
                or not row.get("source_url") or not row.get("email_source")
                or not row.get("phone") or not row.get("firm") or not row.get("id")):
            raise ValueError("a non-strict lead reached the Harvey import boundary")
        key = row["id"]
        if not key.startswith("openleads:strict:") or key in valid:
            raise ValueError("duplicate or untrusted firm identity")
        valid[key] = row
    created = updated = retired = 0
    for key, row in valid.items():
        # Business inbox is preserved in a *private firm note*, never assigned
        # to a fictional first/last name or marked as a person-level verified
        # Harvey prospect. No new campaigns or outbox records are created.
        note = json.dumps({
            "openleads_status": "strict_eligible",
            "published_business_email": row["email"],
            "attorneys": int(row["attorneys"]),
            "headcount_source": row["headcount_source"],
            "email_source": row["email_source"],
            "verified_at": row.get("checked_at", ""),
            "outreach_authorized": False,
        }, sort_keys=True)
        existing = await state.get_company_by_external_id(key)
        if existing is None:
            firm = Company(name=row["firm"], domain="", website="",
                           industry="law firm", company_size=f"{row['attorneys']} attorneys",
                           location=", ".join(x for x in (row.get("city"), row.get("state")) if x),
                           phone=row["phone"], source="openleads:strict",
                           source_url=row.get("source_url") or row["email_source"],
                           external_id=key, notes=note)
            await state.add_company(firm)
            created += 1
        else:
            async with state._connect() as db:
                await db.execute('''UPDATE companies SET name=?,phone=?,location=?,
                    company_size=?,source='openleads:strict',source_url=?,notes=?,
                    updated_at=CURRENT_TIMESTAMP WHERE id=?''',
                    (row["firm"], row["phone"], ", ".join(x for x in (row.get("city"),row.get("state")) if x),
                     f"{row['attorneys']} attorneys",row.get("source_url") or row["email_source"],note,
                     existing.id))
                await db.commit()
            updated += 1
    async with state._connect() as db:
        async with db.execute("SELECT id,external_id FROM companies WHERE source='openleads:strict'") as cursor:
            active = await cursor.fetchall()
        for company_id, identity in active:
            if identity not in valid:
                await db.execute("""UPDATE companies SET source='openleads:withdrawn',
                    notes='Former strict record; evidence no longer qualifies. No outreach authorized.',
                    updated_at=CURRENT_TIMESTAMP WHERE id=?""", (company_id,))
                retired += 1
        await db.commit()
    return {"strict_companies":len(valid), "companies_created":created,
            "companies_updated":updated,"companies_withdrawn":retired,
            "prospects_created":0,"outbound_enabled":False}


def main():
    parser=argparse.ArgumentParser(description="Harvey venv sidecar; no outreach")
    sub=parser.add_subparsers(dest="task", required=True)
    scan=sub.add_parser("discover-osm")
    scan.add_argument("--city",required=True)
    scan.add_argument("--state",required=True)
    scan.add_argument("--lat",required=True,type=float)
    scan.add_argument("--lon",required=True,type=float)
    scan.add_argument("--radius",type=float,default=12)
    scan.add_argument("--limit",type=int,default=30)
    sync=sub.add_parser("sync-strict")
    sync.add_argument("--db",required=True)
    args=parser.parse_args()
    result=asyncio.run(discover_osm(args) if args.task=="discover-osm" else sync_strict(args))
    print(json.dumps(result,sort_keys=True))
    if args.task=="discover-osm" and result.get("error"):
        raise SystemExit(3)

if __name__ == "__main__":
    main()
