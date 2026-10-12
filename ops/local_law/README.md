# Mac local law lead controller — October 12, 2026
Run from macOS, not Railway or Render. The existing law_local worker and SQLite are used without modifying core verification behavior.

- campaign.py: bounded source discovery, state retry ledger, lock, local verification, strict-only export. Florida and New York excluded as fresh-area defaults because prior research already covered Florida and NY grouping is not firm count.
- sync_sheet.py: non-destructive, stable-key Google Sheets upsert; fails closed until LAW_SHEETS_CREDENTIALS points to a service account JSON with access to the existing Sheet.
- test_campaign.py: five isolated strict-export tests.

Run: python3 ops/local_law/campaign.py export ; python3 -m unittest discover -s ops/local_law -q

Local existing launchd schedule points at ~/lead-workspace/campaign.py, not this repository file. Copy reviewed changes to that path when upgrading. Do not commit any credentials, SQLite DB, raw emails or candidate CSV. Do not conflate candidate counts, calling_qualified and strict_eligible. Search-provider negative controls must pass and source email must be attributed to the firm before strict promotion. Main repository PolyForm Noncommercial license governs use; obtain commercial-use authorization before commercial deployment.

## Calling-first campaign output
The primary operational CSV is `~/lead-workspace/call-qualified-law.csv`, exported using the existing `calling_qualified` status. This includes the source-screened phone-qualified records with or without a published email. Email discovery must not block this calling queue. `strict-qualified-law.csv` is an additional email-verified subset and is never a substitute for the calling count. Both remain subject to firm-specific 2–10 attorney evidence and independent no-owned-website checks. No phone connectivity is asserted from formatting alone.

## October 13 audit and source recovery
- Real source artifacts are restored privately under `~/lead-workspace/research_archives/fl` and `.../ny`.
- `python3 ops/local_law/research_index.py` builds a **research-only**, deduplicated `~/lead-workspace/research_catalog.sqlite3` (5,575 FL + 3,488 NY - 26 duplicates = 9,037 identities). It does **not** populate the calling queue.
- The Florida roster's "N active" refers to jurisdiction-active attorneys, not necessarily nationwide firm size. It is now held in `review_headcount_scope` until a separate firmwide size source is obtained. Non-law employer signals are held separately.
- The real CLI verifier now preflights Bing/DDG site providers using a known owned-domain positive control before processing non-FL leads. A failed preflight has process exit 3 and **does not consume candidate attempts**. The current Mac provider health is degraded (1/2 responded, known-positive site missed).
- Calling CSV export independently checks supporting headcount source, exact phone, 2–10 firmwide size, website search evidence and freshness; an invalid status label alone is insufficient.
- The Mac campaign controller records zero yielded candidates as `zero_source_yield` rather than a successful discovery region. It cools down ineffective queries and does not mark an area complete.
- Live local database after scope recheck: 47 headcount-scope reviews and 2 non-law employer reviews, 0 calling-qualified. Do not put these 49 on the calling sheet.
- Execute tests: `/opt/homebrew/bin/python3.11 -m unittest discover -s law_local -q` and `/opt/homebrew/bin/python3.11 -m unittest discover -s ops/local_law -q`.
- Production has not been proven to produce phone-qualified output; do not increase concurrency or reuse generic dead search sources to manufacture throughput.

### Website provider health guard
The Mac controller runs the known-owned-website positive control before verifier batches. When either provider is unhealthy or the positive control is not recovered, it skips candidate website queries and records blocked_website_provider. This prevents wasted HTTP requests but does not certify any website-free firm.

### Recovered archive source triage
`archive_triage.py --max 25` researches recovered firm source pages in resumable SQLite batches; it records explicit firm-owned website hints, source-unavailable errors, and identity/phone mismatches. It does not pretend Florida-local registered count establishes firm-wide 2–10 lawyers or turn missing source links into proof of no website. The Mac controller invokes this batch before geographic query discovery. Each result is checkpointed in `research_catalog.sqlite3`.
