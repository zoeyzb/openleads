# OpenLeads free-fork integration — Mac only

The five owned GitHub forks are registered in `ops/local_law/free_stack.py` and shallow-checkout with `clone_forks.sh` **outside** this repository under `~/lead-workspace/openleads-forks`. No code or private data from those projects is copied into OpenLeads. Their licenses remain in the respective forks. The parent OpenLeads license remains unchanged; verify commercial-use rights before commercial deployment.

## Architecture

| User-owned fork | Adapter and responsibility | Production eligibility impact |
|---|---|---|
| [zoeyzb/google-maps-scraper](https://github.com/zoeyzb/google-maps-scraper) | Existing `start_local_maps.sh` → `local_maps_controller.py` → `ingest_local_maps.py` → research SQLite | Discovery ONLY; empty Maps website ≠ no owned site. Existing running container uses compatible upstream image unless replaced explicitly. |
| [zoeyzb/searxng](https://github.com/zoeyzb/searxng) | `law_local/free_search.py` queries `engines=google cse` and `engines=yahoo` separately over local JSON API | Opt-in only when the named known-owned-site control passes **both** channels. SearXNG inherits upstream CAPTCHAs/HTTP 403 and cannot automatically fix blocking. Default container runs official compatible image; fork is checked out for source changes/custom build. |
| [zoeyzb/yacy_search_server](https://github.com/zoeyzb/yacy_search_server) | `law_local/free_search.py` queries YaCy P2P JSON API | Positive owned-site hints ONLY; missing YaCy indexed results cannot prove website absence. Heavy and opt-in. |
| [zoeyzb/cdx_toolkit](https://github.com/zoeyzb/cdx_toolkit) | `free_stack.py cdx-hints` via isolated optional Python venv | Historical URLs ONLY; existing `commoncrawl_profiles.py` continues to discover dated public directory pages. |
| [zoeyzb/stormcrawler](https://github.com/zoeyzb/stormcrawler) | Registered optional offline crawler source checkout | **NOT STARTED.** Requires Java 25+, Maven, Apache Storm and more resources; it is not a search provider/negative-site verifier. |

```
Owned fork sources (outside Git)    OpenLeads (version controlled)
~/lead-workspace/openleads-forks/   law_local/free_search.py
  searxng/                            search adapters: SearXNG/YaCy
  yacy_search_server/               law_local/worker.py
  google-maps-scraper/                 existing identity + phone + website rules
  cdx_toolkit/                       ops/local_law/free_stack.py
  stormcrawler/                        CLI / registry / diagnostics
                                    ops/local_law/commoncrawl_profiles.py
                                      existing archive discovery
                                    ops/local_law/local_maps_controller.py
                                      existing Maps discovery
```

## Commands

Run from `~/lead-workspace/openleads` on the Mac:

```sh
/opt/homebrew/bin/python3.11 -m ops.local_law.free_stack status
sh ops/local_law/free_stack/clone_forks.sh searxng
# Repeat clone command for yacy_search_server, google-maps-scraper, cdx_toolkit, stormcrawler.
# Private machine only: no reverse proxy or public ports.
docker compose -f ops/local_law/free_stack/compose.yml --profile searxng up -d
/opt/homebrew/bin/python3.11 -m ops.local_law.free_stack probe
/opt/homebrew/bin/python3.11 -m ops.local_law.free_stack inspect 'AXS Law Group' --city Miami --state FL
```

SearXNG runs at `http://127.0.0.1:18888`, with JSON response format enabled in `searxng-settings.yml`. **Keep local verifier scheduler in default mode until the known-owned-site control is healthy and actual negative-site quality has been independently audited.** One-time opt-in for an explicitly controlled research batch:

```sh
OPENLEADS_SEARCH_MODE=local_forks /opt/homebrew/bin/python3.11 -m ops.local_law.free_stack probe
# ONLY if the probe passes AND independent negative-site checks have been calibrated:
OPENLEADS_SEARCH_MODE=local_forks /opt/homebrew/bin/python3.11 -m law_local.worker --db ~/lead-workspace/law-leads.sqlite3 run --max 4 --workers 1 --seconds 90
```

The `run` command still has the worker's preflight. A degraded provider never consumes pending records. No automatic scheduled opt-in, no promotion from research-only tools, no CAPTCHAs bypass, proxies or paid services.

### YaCy (optional)

```sh
docker compose -f ops/local_law/free_stack/compose.yml --profile yacy up -d
# URL http://127.0.0.1:18090 ; positive hints only
# Explicitly enable YaCy checks per session: export OPENLEADS_YACY_ENABLED=1
# Stop to save RAM: docker stop openleads-yacy
```

Use it only while needed. The current workstation is memory- and disk-constrained. YaCy's index completeness is unknown, even when its API works. No YaCy index miss ever upgrades a candidate.

### Common Crawl fork (optional; actual code already checked out separately)

```sh
/opt/homebrew/bin/python3.11 -m venv ~/lead-workspace/openleads-forks/.venv
~/lead-workspace/openleads-forks/.venv/bin/pip install -e ~/lead-workspace/openleads-forks/cdx_toolkit
~/lead-workspace/openleads-forks/.venv/bin/python -m ops.local_law.free_stack cdx-hints 'lawyer.com/firm/example*' --limit 5
```

Live bounded CDX requests can time out; treat an outage as unknown and never as a negative. For mainstream directory discovery, the existing dependency-free `ops.local_law.commoncrawl_profiles` uses the public CDX index directly and does not need this optional package. Archived URLs require current live source matching, domain ownership checks, and practice/phone evidence.

### Gosom fork image (optional custom build)

To run code from the **fork**, build a dedicated local image using the fork's build instructions and then set `OPENLEADS_MAPS_IMAGE` when creating a new container. Do **not** remove/replace `openleads-maps-local` until its job database and data folder are backed up. The existing service already accepts the stable upstream REST API contract. It remains the production Maps collector.

### StormCrawler (future-only)

This source checkout is registered for offline crawling against explicit law-directory allowlists if the machine later has Java 25+, Maven and Apache Storm. It is intentionally excluded from the hourly controller and does not run a hidden heavy background process. **It cannot be treated as an independent web search index.**

## Verification and rollback

Run `python3 -m unittest discover -s law_local -q` and `python3 -m unittest discover -s ops/local_law -q`. Site-provider preflight uses a known-owned-site positive control. Inspect detailed diagnostics rather than treating an HTTP 200 with zero relevant results as search success. To revert the new search adapters, unset `OPENLEADS_SEARCH_MODE`; no schema migration or calling-sheet change is involved. To stop SearXNG: `docker stop openleads-searxng`.

### Provider findings (October 17, 2026)

Original `google`/`bing` SearXNG engines did not pass the owned-domain control. A bounded alternative experiment found `google cse` and `yahoo` both returned the official AXS Law Group website with direct per-engine attribution; `qwant` returned access denied, `brave` was rate-limited, and `mojeek` engine selector unexpectedly fell back to other SearXNG engines. The actual adapters now use `google cse` and `yahoo`. A search-result HTTP 200 without an attributable firm-matching URL is **not** marked as a successful negative search. Always rerun the known-positive preflight before using these sources; it does not prove that any specific firm lacks an owned website.

### Resumable free search research (validated October 17, 2026)

The self-hosted engine pair now defaults to **Google CSE + Yahoo** inside the locally running SearXNG, rather than Google HTML + Bing HTML. Both returned the actual known owned domains for AXS Law Group (`axslawgroup.com`), Baker McKenzie (`bakermckenzie.com`), and Olsen & White (`thelawteam.net`) in bounded live tests on this Mac. These are three positive controls, **not** validation that an indexed-domain absence proves there is no website. Do not enable unbounded retries or rate-limit circumvention.

```sh
# The pair must pass the AXS positive control before making candidate requests.
/opt/homebrew/bin/python3.11 -m ops.local_law.free_stack probe
# Run at most 12 unique Maps research identities per batch.
/opt/homebrew/bin/python3.11 -m ops.local_law.selfhosted_site_pilot --max 4
# Offline only: refine directory-domain classifications from saved evidence.
/opt/homebrew/bin/python3.11 -m ops.local_law.selfhosted_site_pilot --reclassify
```

The research pilot reads only `maps_raw_candidates` from `~/lead-workspace/law-leads.sqlite3`. It prioritizes practices whose names indicate a law firm, skips already qualified/shared calling phones and recently searched records, and records search sources, provider status, URLs, timestamp and verdict in `local_selfhosted_site_checks` in the private `~/lead-workspace/research_catalog.sqlite3`. It **never writes to the verified calling table, exports or Google Sheet**. Incomplete providers produce inconclusive records; possible owned domains—including dedicated WordPress-hosted firm pages—are not cleared. An offline reclassification stores its original/updated decisions in `local_selfhosted_reclass_history` and keeps the original search timestamp.

The initial 13-identity live pilot returned 13 complete pairs, of which 3 were reclassified to `screened_no_site` after precise third-party directory-domain recognition. Ten still need domain/identity review, and **zero** met the complete calling eligibility contract. These numbers are observations for this small batch, not a nationwide qualification rate. A recovered third-party listing is not itself an owned website. The Mac campaign's existing hourly verifier and calling queue are deliberately **not** switched to the new pair from this pilot: provider longevity and false-negative rates still need direct validation on a separate review set, alongside the required source-verified active private practice, matching phone, 2–10 attorneys, and usable published email.

### Stage publicly published attorney-member emails without inflating qualified leads

Some bar and legal-association member profiles contain a member's own business email, firm and matching phone, while also including the **association's** email in the footer. The source-scoped single-member collector avoids that contamination:

```sh
/opt/homebrew/bin/python3.11 -m ops.local_law.stage_member_profile \
  --map-id 'sauk valley law group llc|8155356769' \
  --source-url 'https://www.irela.org/Sys/PublicProfile/63300247'
```

Only a genuine public `https://www.irela.org/Sys/PublicProfile/<numeric-id>` URL is accepted; the collector rejects unrelated hosts **before** fetching. It matches the member-profile firm's business phone and one scoped email against an existing Maps identity and tests the email domain's MX records. An idempotent source URL and masked evidence note are stored in `research_catalog.sqlite3:external_evidence`, **not** in `candidates` or the calling export. A second run returns `email_staged=0` because it is already stored. Sauk Valley has conflicting firmwide lawyer counts, so it remains research-only pending 2–10 verification and complete owned-site review.

### Free source-first attorney-member discovery (October 17, 2026)

`ops/local_law/plea_source.py` collects only member-scoped, published **firm + phone + email + lawyer name** from the Professional Law Enforcement Association's public state directories (`https://plea.net/attorneys/<state>/`). It caches 50 states plus DC for 24 hours in private `research_catalog.sqlite3` (`plea_source_pages`, `plea_firm_research`). A failed/unavailable directory cools down for 24 hours instead of being fetched repeatedly. Grouping by canonical firm AND phone preserves separate branches, attorney name sources, detected cities and possible shared-phone ambiguity. A named participating lawyer is **not** an independently verified active lawyer or a firmwide employee count. No PLEA records are automatically written to the canonical `candidates` table, calling CSV, or Google Sheet.

Commands:

```sh
/opt/homebrew/bin/python3.11 -m ops.local_law.plea_source ingest
/opt/homebrew/bin/python3.11 -m ops.local_law.plea_source audit-sites --max 4
# Positive-only external website proof, when a matching directory page exists:
/opt/homebrew/bin/python3.11 -m ops.local_law.plea_source confirm-owned-site \
  --lead-id aa9d81c981522d546f13c979 \
  --source-url 'https://lawyers.findlaw.com/texas/laredo/4951730_1/'
```

A bounded real scan yielded 334 unique firm + phone research rows from 47 source-backed state directories, including 43 with two or more PLEA-listed member attorneys. This does **not** mean 43 proven 2–10-attorney firms. `audit-sites` requires two independent healthy known-owned-domain checks (as do the main worker and Maps screener), holds plausible firm domains for review, and never directly calls qualification. Two trusted legal directories explicitly linked the attributed firms' own websites; `confirm-owned-site` checks exact firm and phone, the labeled Website anchor and trusted host, then writes append-only `plea_owned_site_audit_history` and `external_evidence` in research SQLite. It cannot clear a firm on a missing source. The source-site evidence remains available for manual reconciliation.

SearXNG upstream `google cse` was rate-limited on October 17 (`unusual traffic`). The **current configured independent pair is `yandex` + `yep`**, each live-verified to recover the official domains for AXS Law Group, Baker McKenzie, and Olsen & White LLP. Search origins remain localhost; no paid API or new public hosting. Yandex/Yep can still rate-limit or omit obscure firms. An HTTP 200 with no attributable firm hit is *not* a completed negative search. The PLEA website pilot remains research-only: **zero new strict qualified**. The hourly Mac campaign invokes a cached PLEA ingest and at most four PLEA website checks per cycle, leaving source-specific 2–10 firmwide proof and practice-activity review as gating steps.
