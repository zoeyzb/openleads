# OpenLeads current policy and operating state — 2026-10-19

The owner removed the attorney-count requirement. Solo, unknown-size, and large private US law firms can qualify. Attorney count/range is optional metadata across discovery, processing, promotion, exports, counts and local CRM sync.

Strict eligibility still requires matched public US private-law-firm identity and business phone, source-published email with a live mail domain, independently screened absence of an attributable owned website, fresh evidence and deduplication. Missing email remains phone-only. Website ambiguity, unavailable providers, government/non-law employers, inactive practices and unverified identities remain excluded.

The target is 10,000 strict leads, with 1,000 as the first milestone. Neither milestone has been reached. Current measured results, tests and limitations are in [the policy/run report](ops/local_law/ANY_SIZE_EMAIL_POLICY_2026-10-19.md). Earlier 2–10 and email-optional policies are historical; do not reinstate them.

## Canonical Mac execution

Repository: `/Users/zainabhassnain/lead-workspace/openleads`, branch `recover-scrape-mcp`.
Canonical queue: `/Users/zainabhassnain/lead-workspace/law-leads.sqlite3`.
The existing `research_catalog.sqlite3` holds unverified historical discovery and PLEA contact research; research volume is not qualified volume.

Hourly launchd job `company.recoverrevenue.lawleads` executes the versioned `ops.local_law.campaign` module from this repository. It uses the existing local Maps and SearXNG containers, locks overlapping cycles, bounds subprocesses, checkpoints discovery and records outcomes. The metrics job runs the versioned publisher every ten minutes. Mac availability and healthy upstream sources are required. No paid hosting was added.

GitHub Actions/cloud copies are separate databases; they do not automatically share the Mac queue. Keep private databases, contact CSVs and credentials out of git.

## Commands

```sh
/opt/homebrew/bin/python3.11 -m ops.local_law.install_worker
/opt/homebrew/bin/python3.11 -m ops.local_law.campaign export
/opt/homebrew/bin/python3.11 -m unittest discover -s law_local
/opt/homebrew/bin/python3.11 -m unittest discover -s ops/local_law
```

The private exports are `~/lead-workspace/strict-qualified-law.csv`, `phone-only-law.csv`, and `call-qualified-law.csv` (the union of both verified contact lanes). Calling count must never be described as strict email count.

## Acquisition and verification

Reuse source-backed archive records before duplicate scraping. Prioritize identity-matched PLEA contact cards with literal published emails. Continue bounded Maps market rotation, public directory profiles, Common Crawl cached URLs, NY registrations and official Washington Bar profiles. Official profiles are discovered from actual returned URLs; member IDs are never generated. Active status and typed employer/phone/email fields are required for Washington contacts.

Two independently named SearXNG upstream engines (Yandex and Yep) must pass owned-site controls. Broader name and exact-phone searches plus direct custom-mail-domain checks add positive ownership hints; they cannot supply missing negative provider evidence. PLEA emails are bound to the same firm/phone card, not borrowed from adjacent firms.

The one-time size-only migration preserves prior evidence and requeues candidates for fresh checks; it never auto-qualifies. Prior website/identity/inactive holds remain authoritative. The archive bridge now skips already queued identities so it can progress past its old first-page starvation.

## Continuation repairs — 2026-10-19

See [continuation evidence](ops/local_law/REPAIR_CONTINUATION_2026-10-19.md) for the remaining legacy Node/Sheets size-gate removal, fresh-candidate queue priority, null-MX validation, Washington retries, retained website-provider observations, and the new bounded IRELA public-contact adapter. The canonical SQLite database and hourly Mac launchd job remain in place. No paid services were added. Runtime counts and full-cycle outcomes remain in the Mac campaign log and continuation checkpoint; raw source volume must never be reported as strict-qualified volume.

### October 19, 2026: executed end-to-end checkpoint

See `ops/local_law/REPAIR_CONTINUATION_2026-10-19.md` for test evidence, the independently controlled empty-search fix, business-identity exclusion, live batch/campaign, Mac disk recovery and real counts. At 06:33 UTC the canonical Mac database held 4 strict email-qualified leads plus 8 separate phone-only leads. Targets of 1,000 and 10,000 remain unmet; no headcount gating was restored. Source-email and site-attribution yield are still the primary blockers. The local campaign completed with exit 0; GitHub/cloud artifact state is not automatically the Mac SQLite state.

### October 19, 2026 — deeper website-verification and source-enrichment repair

See `ops/local_law/DEEP_VERIFICATION_REPAIR_2026-10-19.md`. Reproduced/fixed historical directory-only website holds stuck without revalidation, preserving every unknown/owned-site safety hold and adding seven-day recheck history; removed member-count bias from PLEA email-first site audit; created a source-scoped Wisconsin State Bar local-officer phone/email collector with official robots policy, active-term checking, daily cooldown and government-employer rejection. The real pilot sourced 62 scoped contacts and 55 new *unverified* candidates, and the final full campaign (exit 0) confirmed **4 strict email-qualified leads + 12 separate phone-only = 16 calling-qualified**, in 1,230 unique candidate records. The target of 10,000 strict leads is not met. The 9,037-row historical research corpus is **not** 9,037 verified mailboxes, and possible owned sites cannot be rebranded as no-site firms. Tests: 198 core Python, 149 operations Python and 14 Node scripts passed; source evidence and SQLite preserved.
