# Hybrid law verification repair — October 16, 2026

## Objective and acceptance
Use the user's supplied task as the campaign specification: any private U.S. law practice, matching published phone, no attributable owned site after working independent searches. Email/size are optional. Missing Maps fields and blocked searches never qualify. First acceptance: a real reviewed row survives SQLite -> calling CSV -> fresh export -> existing Sheet; target remains 1,000.

## Implementation plan
1. Preserve the existing dirty branch and source databases; repair residual Sheets size filter and existing-candidate recording.
2. Add an offline review-manifest importer alongside automatic screening. It requires source-bound identity/phone text, explicit private-practice review, two distinct search-provider records with queries/results, positive-control URLs, dated evidence, and review of every returned link. Dedicated hosted business sites remain owned/uncertain, never automatically excluded as directory profiles.
3. Keep evidence privately in SQLite/local review files, not Git. Upsert through existing queue/export contract. A confirmed or suspected site excludes promotion. Replays are idempotent; audit history is append-only.
4. Execute actual searches through authorized tools, import only completed reviews, audit/export, synchronize the existing Sheet, run existing unit suites and push tested changes.

## Architecture and commands
Python stdlib/SQLite; no new dependency, paid API or public prospect data. Modules/tests live in ops/local_law; the existing law_local.worker queue remains canonical.

    /opt/homebrew/bin/python3.11 -m unittest discover -s law_local -q
    /opt/homebrew/bin/python3.11 -m unittest discover -s ops/local_law -q
    /opt/homebrew/bin/python3.11 -m ops.local_law.import_site_reviews --db ~/lead-workspace/law-leads.sqlite3 --file ~/lead-workspace/site-reviews.json

Follow existing snake_case/JSON conventions, e.g. `return {"imported": count}`. Validate before any mutation. Never commit databases, evidence manifests, credentials or prospect lists. Do not deploy production. Existing per-provider search automation stays fail-closed; ChatGPT search access is not available to the unattended Mac scheduler.

## Verified discoveries and expanded repair
The main eligibility code had been updated but discovery still excluded solos and large firms in Florida roster intake, Common Crawl profile extraction and directory profile parsing. Removed those staging filters while retaining matching published identity/phone and private-practice checks. Size remains optional descriptive evidence. The search health preflight previously let one passing provider mask the other's missing control; now each must pass independently.

## Checkpoint — 2026-10-16
- Baseline qualified count 0. Current count 1; fresh export returns 1 and review replay returns 0 new / 1 replay. SQLite, CSV and existing Verified Calling Queue agree. Target 1,000; gap 999. This is partial completion.
- Fixed residual size gates in three source adapters, Sheets sync, and existing-candidate screening. Reopened 217 historical Common Crawl size-only rejects while retaining prior verdicts. A bounded six-page live rerun fetched all six, staged four and found two explicit website links. Independent follow-up withheld all four staged firms (two official matching-phone sites, two attributed-site links).
- Current main queue: 230 pending, 20 inconclusive, 12 website-review, 2 nonlaw-review, 1 verified. Research archive 9,037 source identities is separate, not additive verified output. Maps shortlist 21 unverified; 12 website flags (one official matching-phone owned site, eleven unresolved links/hosted pages), one deceased-practitioner rejection, one verified, and remaining unreviewed Maps rows.
- New directly confirmed owned-site exclusions in this session: 3 (two Common Crawl queue candidates, one Maps candidate). Additional uncertain/attributed website signals are not claimed as confirmed ownership. Historical source evidence remains intact.
- Local Maps container running. Completed recorded market jobs: Galesburg 23, Burlington 20, Cedar Falls 21, Ottumwa 21, Keokuk 9 = 94 raw listings. New Ottumwa and Keokuk research additions are never qualified by missing metadata. Existing hourly launchd job remains interval 3,600 seconds; last observed exit code 0. Mac sleep still pauses work.
- Automated Mac Bing/DDG preflight remains degraded, 0/2. Assisted search channels both returned Kirkland's owned site as positive controls, but relevance varies and the Mac scheduler cannot call the ChatGPT search tools. Hybrid manifests are an operator workflow, not unattended website verification. Do not promise automatic progress to 1,000.
- Sheets row 2 of Verified Calling Queue was written and read back. Removed 171 obsolete main-sheet status labels and refreshed the dated hidden pipeline snapshot. Scheduled Sheets sync remains blocked: LAW_SHEETS_CREDENTIALS is not configured. Connector sync succeeded in-session only. Manual notes were preserved.
- Verification: 100 law_local tests + 51 ops/local_law tests passed; git diff --check passed. No prospect records, database files, private manifests, credentials or local queue JSON are committed. No Vercel deployment.
- Existing aggregate Gist was refreshed; private local queue regenerated. Original schema/API compatibility retained where used; the obsolete Florida listing aggregate name now accurately says active_practice_listings.

## Lessons and next execution
1. Changing final qualification without changing intake leaves valid practices stranded. Check source-stage filters and saved prior exclusions together.
2. Directory website redirects must be followed: both additional promising Common Crawl firms had hidden attributable domains. Do not certify from search snippets alone. Dedicated hosted landing pages require ownership review.
3. One healthy provider cannot compensate for another provider failing its own known-site control. Errors and off-topic results remain inconclusive.
4. Continue with the 211 reopened Common Crawl profiles awaiting policy recheck, bounded per hourly cycle, prioritizing source-linked phone identities and preserving confirmed site exclusions. Scale independent verification only after a dependable accessible source exists; no paid key is assumed.
5. Review manifests must cite actual searches/source pages and resolve every attributable site signal. Revalidate the export after import and after scheduler runs.

## Source influence
Applied addyosmani-style systematic debugging/specification and regression verification through installed skills; Understand-Anything-style dependency inspection through the codebase skill; browser-use-style provenance, retries, bounded acquisition and checkpoints through the scraping skill. Reused this repository's actual plumbing Gosom/identity/coverage patterns through existing local controllers. No reference-repository code was copied and no new libraries or hosted services were added.

## Final runtime update
The restarted scheduler retained 1 calling-qualified record on its fresh preflight. It is running the bounded existing backlog. Disk free space fell to about 5.0 GiB, so Maps correctly returned paused_low_disk under the existing 6 GiB guard. Inspection found only 4 MiB of Maps data and no /tmp browser cache in the collector; this is not fixable by deleting disposable project files. Free at least 1 GiB elsewhere before new Maps jobs resume; no unrelated user data/services were modified. Automated independent search remains degraded.

Commit 42b70e1 was successfully pushed to recover-scrape-mcp. This follow-up also removes missing-size rejection from the Florida source while retaining explicit zero-active/inactive rejection. Current backlog counts can change during the active scheduler run; the dated Sheet snapshot is labeled accordingly.

Final fresh scheduler audit at 10:50:54 UTC: run 9 completed with exit 0; interval remains 3,600 seconds. Queue has 1 verified, 214 pending, 40 inconclusive, 12 website-review and 2 nonlaw-review (269 total). Calling CSV re-exported exactly 1 record. Reopened Common Crawl backlog is now 199, after the bounded six-profile manual test plus the scheduled 12-profile cycle. The current unresolved main verification queue is exactly 254 records. Disk guard remains paused at approximately 5 GiB; no disposable collector cache was present. Final tests: 151 passed.
