# Standalone, self-hosted law Maps collector on the Mac

The home-services lead workflow used Google Maps business data (company name, category, address, phone, website). The law-firm equivalent **already exists** in `law_local/maps_extract.py` and `law_local/maps_first.py`. A missing Maps website field is **an acquisition hint**, never evidence sufficient to qualify a firm as not owning a website. Law-firm calls additionally require independently evidenced firmwide 2–10 attorneys. Do not reinterpret historical HVAC/plumbing counts as audited owned-site absence.

## Mac startup (no Railway, Redis or paid Maps API)

- OrbStack: `orb start` (Mac must be on; the service isn't accessible when the Mac sleeps or is off).
- Start container: `sh ops/local_law/start_local_maps.sh`
- Web UI / API: <http://127.0.0.1:18080>, bound to localhost (not exposed to Internet).
- Container: `openleads-maps-local`; data stored privately at `~/lead-workspace/local-maps-data` and capped to 2 CPU cores / 2 GiB memory. Docker restart policy is `unless-stopped`, subject to OrbStack running.
- Check: `curl http://127.0.0.1:18080/api/v1/jobs`
- Stop: `docker stop openleads-maps-local`
- This runs the MIT-licensed `gosom/google-maps-scraper` Docker image; no Redis or paid proxy credentials.

## First real end-to-end pilot

A job with two Chicago law-firm searches, depth 1, `max_time=180`, was accepted by `POST /api/v1/jobs` with job ID saved privately to `~/lead-workspace/local-maps-pilot-job.json`. The job finished with Gosom `Status: ok`.

Run `python3 -m ops.local_law.ingest_local_maps` to import an already **completed** local job. The existing hourly Mac campaign checks this job file and imports completed results idempotently; no duplicate scraper job is started by the importer. Private raw CSV and research-only output are under `~/lead-workspace/local-maps-data/imports`.

Pilot actual counts: **40** Maps listings; **40** website fields populated; **40** published phone fields; **zero** blank-website source candidates; **zero** qualified calling leads. This proves the collector+CSV workflow runs end-to-end, but not that the no-website law-firm targeting goal is solved. Try undercovered smaller cities with carefully bounded queries before scaling. The original 400-listing law Maps pilot produced 17 blank-website business-phone candidates; these also remained unverified for attorney count/site absence.

## Required gates before any lead is callable

1. Real private law practice identity and matched publicly published business phone.
2. Firmwide attorney count **2–10**, independently supported (not a single-state registration count).
3. Independent website evidence; missing Maps website metadata alone is inconclusive. Exclude firms with matching official sites.
4. Record evidence URL, status, timestamp and export only after complete verified classification. Email is optional for calling, required for strict email outreach.

**Do not** feed these raw Maps rows directly into `calling_qualified` or the public metrics. The local research queue is `maps_raw_candidates` in the original `law-leads.sqlite3`, and it must be further verified before promotion. Hosting the collector locally does not fix upstream search restrictions, website-negative evidence or firmwide-size sources. Keep RAM and disk usage in check: only about 9 GiB disk was free following image installation.

## Small-market pilot and recovery, October 16

A second localhost Gosom job searched Galesburg IL, Cedar Falls IA and Burlington IA with three depth-1 queries. It completed with `Status: ok`. There were 60 real Maps listings; eight had a blank website field plus a usable public business phone and were inserted into the private `maps_raw_candidates` table. A Chicago depth-1 pilot had 40 listings, all with published website fields and zero research candidates. The original historical 17 qualified-for-research Maps records were imported from `~/lead-workspace/research_archives/fl/maps/no-site-phone-candidates.csv`; total research-only Maps queue reached 25 (17 + 8). These remain unverified for firmwide 2–10 attorneys and no owned site, so calling-qualified count is zero.

The original `law_local.maps_first.verify_map_headcounts` source-resolver pilot tried 25 records. Bing RSS returned 25 transport-level responses but **zero relevant directory profile links**. There were zero firmwide-size/phone matches and zero new verification-stage records. Its seven-day no-relevant-results cooldown prevents immediate repetition, but this resolver needs replacement with a source providing identity-matched, published firmwide size before Maps research can scale to 1,000 verified law firms. Responsive HTTP search results are not equivalent to useful source evidence.

The local controller includes `ops.local_law.restore_archived_maps` for idempotent recovery of the historical Maps CSV and `ops.local_law.ingest_local_maps` for completed localhost Gosom jobs. The importer never certifies no-owned-website from blank Maps metadata. Running a collector locally solves scraping infrastructure only; it does not change the quality of external directory or site-search data.
