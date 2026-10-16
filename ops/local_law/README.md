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

## Phone-first Google Sheets export (2026-10-13)
The verified calling-output Sheet is **Verified Calling Queue** in Recover Revenue — Law Lead Live Tracker. Run `python3 ~/lead-workspace/sync_sheet.py --preview` to inspect sanitized phone-qualified rows without Google credentials. The unattended local upsert requires authorized credentials (`LAW_SHEETS_CREDENTIALS`); it will not claim any Sheet write without authentication. ChatGPT’s connected Drive task can handle a separate six-hour sync. Do not confuse this calling-qualified list (email optional) with the stricter email-evidenced eligible subset.

Mac browser probes: Lawyers.com, Justia and Martindale returned HTTP 403; a subsequent FindLaw fetch also returned 403, and a headless Google known-website query failed the positive-domain control. Browser access alone does NOT repair owned-website absence verification; do not bypass challenges.

Critical operational fix: archive_triage.py now inserts its repository root in sys.path before importing law_local.worker, because the scheduled file-path subprocess otherwise failed ModuleNotFoundError and processed zero archived leads.

## Dashboard live Mac metrics feed (2026-10-16)
The static, redesigned dashboard is `site/law-dashboard/`. Its browser JS reads a versionless URL for an **unlisted GitHub Gist** containing public, aggregate-only metrics; the Mac runs `ops/local_law/publish_metrics.py` from `~/lead-workspace/publish_metrics.py` via a single `launchd` publisher every ten minutes. This is intentionally a near-live feed rather than exposing local SQLite or adding a hosted scraper. The unlisted Gist URL is accessible to anyone who knows it; no lead names, phones, emails, firm URLs, credentials, or raw DB are published. Do not treat an unlisted Gist as private authentication.

To install the Mac publisher: copy `ops/local_law/publish_metrics.py` to `~/lead-workspace/publish_metrics.py`, authenticate GitHub CLI with `gist` permission, run the publisher once to create `~/lead-workspace/metrics-feed-config.json`, and schedule it with macOS `launchd`. The script requires `gh` from `/opt/homebrew/bin/gh`. Do not commit the personal Gist config or business lead files. The dashboard labels snapshots older than 30 minutes as stale; the browser polls once per minute without touching the Mac directly.

### Live analytics charts
Dashboard now includes interactive bar/donut charts of FL/NY research sources and candidate-status bars, derived from real aggregate Mac SQLite data. The publisher exports sourceBreakdown every ten minutes. Visual reference: MIT-licensed shreyvijayvargiya/crm-saas; no additional Next.js service was installed and no source components were copied.
Verified in Chrome at 1440px and 390px with no overflow, including bar/donut switch.

### October 2026 repair pass
- Controller no longer raises UnboundLocalError when website verifier is intentionally skipped, and handles site-provider preflight timeout as an explicit controlled failure (exit 3). This does not make degraded providers valid or promote prospects.
- Public aggregate Mac metrics publisher now preserves genuine hourly observations in private local metrics-history.json and publishes up to 168 observed hourly snapshots (no backfilled or synthetic history).
- Dashboard has a live historical trend chart with qualified / triaged / candidates switches and a usable mobile navigation menu.
- Connected hourly ChatGPT Google Sheets task upserts source-verified calling leads directly through connected Google Sheets, without expecting an absent local service account. The local sync_sheet.py credential-based path remains unavailable until authorized credentials are provided. Qualified rows are still 0; no fabricated sync rows.

## October 16 repair
- Fixed Mac controller so a degraded website-provider health check returns a controlled scheduler result (code 0 with verify_exit=3 recorded); source/acquisition subprocess failures still return nonzero. Unbound pending and preflight timeouts remain guarded.
- Metrics Gist now exposes lastVerification timestamp/exit/siteHealth from local log without source URLs, names or phones; dashboard uses the latest recorded verification state, not an old one-off provider probe.
- Connected Google Sheets tab Verified Calling Queue was verified present (header A:L, zero eligible rows). Its hourly connected sync is active; local service-account writer remains blocked pending Google credentials, so do not claim native unattended local API upsert is configured.
- 0 real qualified calling leads, independent firmwide headcount and website absence still not solved. Never count raw contacts as qualified.

## October 16 geographic and archive selection fixes
- The Mac job was observed to finish with exit 0 after controller crash repair; verification exit 3 still records degraded site screening separately.
- Existing coverage.sqlite3 contained leftover FL and NY generic source rows. Queries now constrain scheduled generic discovery to configured STATES, preventing stale checkpoint rows from forcing repeated Florida/NY runs.
- Archive triage now includes NY registrations, with NY prioritized to ensure the previously excluded source is actually tested. State registration counts remain *research-only*, never firmwide headcount proof.
- These fixes improve scheduling and coverage but do not cure search-provider health or produce qualified calling leads.

### Website search provider diagnostics (2026-10-16)
Live Mac probes show Bing RSS serving unrelated Wikipedia, Microsoft and gaming links to firm-name/domain queries; DuckDuckGo HTML is blocked. Do not permit irrelevant HTTP 200 payloads to certify website absence. The site preflight now emits per-provider responded/result_count diagnostics; the fail-closed behavior remains intact.
The calling verifier still classifies no-email firms as `call_qualified_no_email` after all firm-size, website and phone gates pass. Published email harvesting is a bonus.

## Current audit — 2026-10-16

**Eligibility source of truth:** phone-first; firm-wide 2–10, genuinely no owned website, published and matching business phone, real law practice. Email enriches, but never gates phone qualification.

Fresh Mac provider preflight: DEGRADED (0/2 usable; known-positive owned domain unrecovered). Verified zero calling/exported and zero strict-email rows. Active DB: 11 pending / 47 scope review / 2 non-law. Historic research: 9,037 FL+NY. Source triage: 281 requiring independent proof, 9 identity/phone mismatch, 7 unavailable, 1 owned-site exclusion; counts are **research** not call-ready. Recent macOS scheduler exited 0 while verifier_exit 3 remained blocked: do not equate launcher success to verification health. Sheet exists and is header-only; local service-account authentication remains missing and connected hourly task has no verified writes yet.

**Do not hide the missing source problem with UI, more workers, or zero-yield discovery loops.** Require a validated firm-wide size source plus *two genuinely independent* healthy owned-site searches, demonstrated on known-owned controls and ordinary firms; archive and cite each evidence URL. Preserve optional email discovery. Follow the prioritized remediation and acceptance tests in the repository root README.

## 2026-10-16 lightweight recovery pass
- Previous Railway metric snapshots show 177 call-ready and ~1,608 headcount-verified records (2026-10-02), not 10,000 verified law leads/hour. Do not conflate plumbing throughput, research discovery volume, and qualified law firms.
- Keep plumbing and law independently configured; no new Railway/Render, Redis daemon, hosted worker, or second canonical lead database.
- Archive triage now uses a single SQLite indexed query, prioritizing records with state-reported 2-10 attorney *hints* and an existing published phone. The state count is strictly scheduling metadata, **not firmwide eligibility proof**.
- Records processed in source_triage are checkpointed; no duplicate full copy of the 9,037 records is created. The prerequisite independent website and firmwide evidence remains blocked; this does not raise verified qualified counts.

## 2026-10-16 archive reuse
Old Railway snapshot (Oct 2): 177 call-ready, ~1608 size-verified; not evidence of 10000 qualified law/hour. Plumbing rates should not be counted as law.
Existing catalog feeds a bounded 20-per-run candidate bridge without a second database or new service. SQLite dedupes and caps pending queue at 100. Ten sourced research candidates imported during test. They are NOT qualified leads. Firm-wide 2-10 and independently checked no-owned-site remain required, phone is mandatory, published email bonus only.

## 2026-10-16 — remove all-or-nothing verifier outage
- Previous controller skipped the entire 20-row verification batch when website provider preflight failed. Now the verifier continues accessible source/identity/headcount/positive-owned-site checks without calling unhealthy site search adapters. Any firm requiring independent negative website proof remains inconclusive; no email required for calling eligibility.
- The verifier preflight remains visible in logs; known-owned-site controls are not bypassed. This avoids stalling source triage while external search is down; **it does not certify no website**.
- Live bounded test against the Mac queue processed 2 sourced candidates (both inconclusive), no false qualified leads. 87 core tests passed, including outage no-search regression.
- No new repository, hosted runtime, database, or worker service created.
