# Law acquisition policy: any law firm, no owned website (October 16, 2026)

The user explicitly **removed the former 2–10 attorney-size requirement**. A solo practice, a five-lawyer firm, or a larger law firm is in scope if it is a real private law practice with a published business phone and independently screened no identifiable owned website. **Never require an attorney-count value or firmwide attorney-size document to qualify calling records.** Email remains optional for phone leads, and its source-specific verification remains mandatory for email-specific exports.

The qualification gates are:

1. Publicly attributed private law-firm identity and a matching published business phone. The identity proof may be an actual firm-directory listing or the business's source-linked Google Maps listing.
2. No independently identifiable owned website after two functioning search checks, including their own known-owned-site positive control; a missing Google Maps website link **alone** is not sufficient. Site search outages, zero HTTP hits, blank directory website fields, and blocked HTTP 202/403 are *inconclusive* rather than negative proof.
3. Evidence timestamp, source URL, search-provider results and source identity preserved in SQLite. Only `call_qualified_no_email`/`strict_eligible` records satisfying this evidence contract can appear in qualified calls exports.

## Implementation

- `law_local.worker.evaluate_candidate` and `SqliteQueue._verified_for_export` no longer require a 2–10 firm size. Old `review_headcount_scope` records migrate to `pending` without automatically becoming qualified. Published phone/firm matching and owned-website exclusion remain.
- `law_local.worker.apply_verified_bar_contact_proof` may attach a verified email after an independently completed website clearance without attorney-size requirements.
- `ops.local_law.screen_maps_websites` screens Maps records directly, without an attorney-count resolver. It checks the known-owned-site positive control first, and refuses to burn retry attempts when providers are degraded. A verified search clearance can create an identity-matched, phone-ready row with Maps provenance. Test fixtures demonstrate both successful and fail-closed behavior; no mocked rows enter production.
- `ops.local_law.export_maps_no_listed_site` writes the private `~/lead-workspace/law-maps-no-site-listed-UNVERIFIED.csv`; this is **research only**, and its `Calling qualified` value is always NO. It excludes website flags discovered during the independent Maps audit. The previous CSV `~/lead-workspace/law-research-1000-UNVERIFIED.csv` is also **not** a verified lead list.
- The Mac hourly campaign runs new direct website screening and research exports. The law dashboard states the current policy instead of retaining stale 2–10 language.

## Current verification result

As of implementation, the free HTML/RSS website search sources were degraded from the Mac (`responded=0/2`, known-owned-site control not found). Five early Maps screening attempts were inconclusive, and the new worker pauses further attempted negative checks while the health control is unavailable. The 27 Maps missing-website-field firm phone prospects remain research, **zero were confirmed no-owned-site**, and the qualified calling count remains **0**. The acquisition/source collection process is independent and can continue on the Mac while website-search verification needs a genuinely usable independent source. Do not misreport those 27 as 27 verified no-website firms.
