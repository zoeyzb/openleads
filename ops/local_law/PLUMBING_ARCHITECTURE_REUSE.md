# Plumbing/HVAC acquisition system reused in OpenLeads — 2026-10-16

## Actual predecessor architecture (recover-mcp)

1. `acquisition-worker.mjs` accepts country/city, industry, search/coverage family and a bounded Maps query bundle; `createMapsJobWithFailover` submits to Gosom (`/api/v1/jobs`), polls status and downloads CSV. Redis queues and lease/cooldown keys previously coordinated workers and service failover.
2. `geo-coverage.mjs`, `acquisition-coverage.mjs`, `national-yield-priority.mjs` rotate locations and measure yield. Home-service targeting in `home-service-targeting.mjs` accepts plumbing/HVAC categories, rejects unrelated trades and distinguishes actual owned domains from social/directory profile links.
3. `acquisition-persistence.mjs` merges leads by identity keys (place ID, CID, domain, phone, normalized name/address), preserving existing fields and source context. `strict-owned-website-gate.mjs` treats failed website checks as inconclusive, NOT a verified negative.
4. Enrichment modules collect publicly linked contacts with provenance, then apply strict campaign-specific gates before calling or email eligibility. Historical plumbing no-website intake often used a missing Maps owned-website field as an *opportunity signal*, not conclusive absence of an owned business site.

## Implementation now on the Mac

- The same Gosom image runs isolated on `127.0.0.1:18080` via OrbStack; no Railway, Redis or paid Maps API required.
- `law_local.maps_extract` interprets published website fields and recognizes social/directory profile-only URLs, but marks such rows *unverified*, as a missing Maps site listing is not proof of no owned website.
- `ops.local_law.local_maps_controller` is a SQLite-checkpointed, disk-space-aware, one-at-a-time city rotation using bounded two-query depth-1 jobs. It tracks new/raw yield, persists job IDs, never restarts a failed market indefinitely and stops when its locality list is exhausted. It runs once per hourly existing Mac `campaign.py` cycle; does not run continuous autonomous API requests.
- `ops.local_law.ingest_local_maps` downloads completed jobs to a private local path and inserts only distinct Maps research records. The original `law_local.maps_first` verifier remains the mandatory bridge between Maps and source-backed attorney counts.
- Additional source safety: for non-Lawyer.com legal directory pages, the published phone and firm identity must match the Maps identity before a reported 2–10 headcount can be used. Otherwise do not promote.
- Main qualified call export remains separate; live verified count was zero during this work.

## Evidence of acquisition yield (not verified lead count)

- Chicago pilot: 40 listings, all 40 with owned website fields, zero blank-website phone candidates.
- Galesburg/Cedar Falls/Burlington pilot: 60 listings, eight blank-site phone candidates; 17 archived Maps candidates recovered and deduped in the same SQLite research table.
- Controller first Galesburg cycle: 23 listings, six Maps research candidates, one new after deduplication; a Burlington job was then submitted.
- Separate first 25-source resolver audit: Bing RSS yielded no firm-specific profile URLs even though it returned syntactically valid responses. The firmwide-size evidence channel and independently corroborated no-owned-site checks remain the critical bottlenecks.

## Operational limits and next upgrades

- New candidates require firmwide size of 2–10 from a source with scope stronger than state-specific licensing counts, matching public business phone, and independent site checks. Never convert a missing Maps site field or a blocked search into `no_owned_website_verified=true`.
- Directory and site-search providers should be assessed on positive-control recall; use live matched firm+phone source links when available, and log unavailable providers explicitly. Self-hosting does not make external search data independently available.
- Mac had ~9 GiB free disk near image installation; the controller pauses submissions below 6 GiB. Running many simultaneous Chromium jobs is disabled. If the Mac sleeps/off, jobs won't progress. Local Maps service uses restart `unless-stopped` and is not public.
- No cross-import of HVAC/plumbing leads, no changes to third-party infrastructure, and no paid services.
