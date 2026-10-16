"""Conservatively reconcile confirmed owned-site evidence into the existing verifier queue.

No firm is promoted; original qualification/export gates remain authoritative.
"""
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path.home() / "lead-workspace"
THIRD_PARTY = ("floridabar.org", "superlawyers.com", "ailalawyer.com",
               "lawinfo.com", "signalhire.com", "salary.com", "google.com",
               "facebook.com", "linkedin.com", "lawyer.com", "findlaw.com")
AMBIGUOUS = ("unresolved", "phone differs", "possible", "ambiguous", "unconfirmed")

def direct_owned_proof(url, note):
    host = (urlparse(url).hostname or "").lower()
    if not host or any(host == d or host.endswith("." + d) for d in THIRD_PARTY):
        return False
    note = note.lower()
    return not any(term in note for term in AMBIGUOUS) and any(
        term in note for term in ("official", "firm-owned", "firm-controlled", "matched", "matches")
    )

def reconcile(queue_path=ROOT/"law-leads.sqlite3", research_path=ROOT/"research_catalog.sqlite3"):
    with sqlite3.connect(queue_path, timeout=20) as queue:
        queue.row_factory = sqlite3.Row
        queue.execute("ATTACH DATABASE ? AS research", (str(research_path),))
        proofs = queue.execute("""
          SELECT c.id,c.firm,c.phone,c.status,c.result_json,e.proof_url,e.note,e.verified_at
          FROM candidates c JOIN research.source_research s ON s.lead_id=c.id
          JOIN research.external_evidence e ON e.lead_id=c.id
          WHERE e.kind='owned_website' AND lower(trim(s.firm))=lower(trim(c.firm))
          AND s.phone=c.phone AND s.state=c.state
        """).fetchall()
        changed = 0
        for row in proofs:
            if not direct_owned_proof(row["proof_url"], row["note"]):
                continue
            prior = json.loads(row["result_json"] or "{}")
            if prior.get("site_status") == "published_owned_website" and prior.get("owned_site_url") == row["proof_url"]:
                continue
            prior.update(status="review_website", site_status="published_owned_website",
                         owned_site_url=row["proof_url"], owned_site_evidence_note=row["note"],
                         owned_site_evidence_checked_at=row["verified_at"],
                         reason="Confirmed owned website; ineligible for no-website outreach")
            queue.execute("UPDATE candidates SET status='review_website',result_json=?,updated=? WHERE id=?",
                          (json.dumps(prior, sort_keys=True), datetime.now(timezone.utc).isoformat(), row["id"]))
            changed += 1
        queue.commit()
        return {"owned_site_queue_reconciled": changed, "candidate_evidence_rows_checked": len(proofs)}

if __name__ == "__main__":
    print(json.dumps(reconcile()))
