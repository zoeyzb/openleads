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
