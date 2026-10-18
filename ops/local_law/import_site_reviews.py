"""Import completed operator research, preserving provenance and fail-closed gates.

The Mac scheduler cannot access ChatGPT search tools. This bounded CLI bridges
actual independently reviewed searches; it does not manufacture search results.
Keep manifests outside Git. Replays do not increment attempts or duplicate leads.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
from law_local.worker import SqliteQueue, firm_identity_matches, utc_now, norm
from law_local.florida_roster import clearly_non_law_employer

STATES=set("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split())

def public_url(value):
    p=urlparse(str(value))
    return p.scheme in ("http","https") and bool(p.hostname) and p.hostname not in ("localhost","127.0.0.1")

def fresh(value, days=7):
    try:
        age=datetime.now(timezone.utc)-datetime.fromisoformat(value.replace("Z","+00:00"))
        return 0<=age.total_seconds()<=days*86400
    except (TypeError, ValueError, AttributeError):
        return False

def validate(review):
    lead=review["lead"]
    if lead.get("state") not in STATES or not public_url(lead.get("source_url","")):
        raise ValueError("US state and public identity source required")
    if review.get("private_practice_confirmed") is not True or clearly_non_law_employer(lead["firm"]):
        raise ValueError("private law practice identity required")
    if not firm_identity_matches(review.get("identity_text",""),lead):
        raise ValueError("source text must bind the firm name and published phone")
    if not fresh(review.get("checked_at")) or not review.get("reviewer"):
        raise ValueError("fresh dated operator review required")
    providers=review.get("providers",[])
    if len(providers)!=2 or len({p.get("provider") for p in providers})!=2:
        raise ValueError("two distinct search providers required")
    for p in providers:
        if not p.get("provider") or p.get("responded") is not True or not p.get("query") or not fresh(p.get("checked_at")):
            raise ValueError("completed dated search and query required")
        # At least one relevant returned result prevents irrelevant/blank search
        # envelopes from being interpreted as negative ownership evidence.
        hits=p.get("results",[])
        if not hits or not any(h.get("relevant") is True for h in hits):
            raise ValueError("attributable relevant results required")
        control=p.get("positive_control",{})
        domain=control.get("expected_domain","")
        control_urls=control.get("urls",[])
        if not domain or not control.get("query") or not fresh(control.get("checked_at")) or not any(
            (urlparse(u).hostname or "").removeprefix("www.")==domain for u in control_urls):
            raise ValueError("each provider must pass its own dated known-site control")
        for h in hits:
            if not public_url(h.get("url","")) or not h.get("note") or h.get("disposition") not in ("directory","social","unrelated","owned","uncertain"):
                raise ValueError("every result needs an explicit ownership review")
    if not review.get("notes"):
        raise ValueError("review conclusion required")
    return lead

def import_reviews(db_path,reviews):
    # Validate the complete batch before changing production data.
    for review in reviews: validate(review)
    db=SqliteQueue(db_path)
    db.conn.execute("""CREATE TABLE IF NOT EXISTS operator_site_reviews(
        digest TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, imported_at TEXT NOT NULL,
        review_json TEXT NOT NULL)""")
    stats={"new_verified":0,"owned_or_uncertain":0,"replayed":0}
    try:
        for review in reviews:
            raw=json.dumps(review,sort_keys=True)
            digest=hashlib.sha256(raw.encode()).hexdigest()
            if db.conn.execute("SELECT 1 FROM operator_site_reviews WHERE digest=?",(digest,)).fetchone():
                stats["replayed"]+=1
                continue
            lead=review["lead"]
            db.add(lead)
            cid=db._id(lead)
            existing=db.conn.execute("SELECT result_json FROM candidates WHERE id=?",(cid,)).fetchone()
            prior=json.loads(existing[0] or "{}")
            if prior.get("eligibility_hold") or prior.get("status") in ("rejected_inactive","review_inactive"):
                raise ValueError("existing inactive-practice hold requires explicit resolution")
            flagged=[h for p in review["providers"] for h in p["results"] if h["disposition"] in ("owned","uncertain")]
            # Existing conclusive owned-site evidence cannot be erased by a
            # new negative search. Explicitly resolve it outside this importer.
            prior_owned=prior.get("site_status")=="published_owned_website" or bool(prior.get("owned_site_url"))
            if not flagged and prior_owned:
                raise ValueError("existing owned-site evidence requires explicit resolution")
            before=db.counts()["calling_qualified"]
            result={
                "firm":lead["firm"],"phone":lead["phone"],"attorneys":None,
                "status":"review_website" if flagged else "review_firmwide_headcount",
                "qualification_scope":"website_review_only",
                "source_url":lead["source_url"],"headcount_source":lead["source_url"],
                "site_status":"review_website" if flagged else "screened_no_site",
                "checked_at":review["checked_at"],"email":"","email_source":"",
                "review_method":"operator_two_provider_review",
                "site_evidence":{"providers":review["providers"]},
                "operator_review":review}
            if flagged:
                result["owned_site_url"]=flagged[0]["url"]
                stats["owned_or_uncertain"]+=1
            db.record(lead,result)
            stats["new_verified"]+=max(0,db.counts()["calling_qualified"]-before)
            db.conn.execute("INSERT INTO operator_site_reviews VALUES(?,?,?,?)",(digest,cid,utc_now(),raw))
            # Link existing Maps research to this review; candidate identities
            # may use a fuller published firm name than the Maps label.
            tables={r[0] for r in db.conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if "maps_raw_candidates" in tables and "maps_website_checks" in tables:
                for m in db.conn.execute("SELECT map_id,firm FROM maps_raw_candidates WHERE phone=? AND state=?",(lead["phone"],lead["state"])).fetchall():
                    if norm(m["firm"])!=norm(lead["firm"]): continue
                    db.conn.execute("""INSERT INTO maps_website_checks VALUES(?,?,?,?)
                        ON CONFLICT(map_id) DO UPDATE SET checked_at=excluded.checked_at,
                        status=excluded.status,result_json=excluded.result_json""",
                        (m["map_id"],review["checked_at"],result["site_status"],json.dumps(result)))
            db.conn.commit()
        stats["calling_qualified_total"]=db.counts()["calling_qualified"]
        return stats
    finally:
        db.close()

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--db",default=str(Path.home()/"lead-workspace/law-leads.sqlite3"))
    p.add_argument("--file",required=True)
    args=p.parse_args()
    print(json.dumps(import_reviews(args.db,json.loads(Path(args.file).read_text()))))
if __name__=="__main__": main()
