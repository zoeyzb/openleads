# OpenLeads free-fork integration — Mac only

The five owned GitHub forks are registered in `ops/local_law/free_stack.py` and shallow-checkout with `clone_forks.sh` **outside** this repository under `~/lead-workspace/openleads-forks`. No code or private data from those projects is copied into OpenLeads. Their licenses remain in the respective forks. The parent OpenLeads license remains unchanged; verify commercial-use rights before commercial deployment.

## Architecture

| User-owned fork | Adapter and responsibility | Production eligibility impact |
|---|---|---|
| [zoeyzb/google-maps-scraper](https://github.com/zoeyzb/google-maps-scraper) | Existing `start_local_maps.sh` → `local_maps_controller.py` → `ingest_local_maps.py` → research SQLite | Discovery ONLY; empty Maps website ≠ no owned site. Existing running container uses compatible upstream image unless replaced explicitly. |
| [zoeyzb/searxng](https://github.com/zoeyzb/searxng) | `law_local/free_search.py` queries `engines=google` and `engines=bing` separately over local JSON API | Opt-in only when the named known-owned-site control passes **both** channels. SearXNG inherits upstream CAPTCHAs/HTTP 403 and cannot automatically fix blocking. Default container runs official compatible image; fork is checked out for source changes/custom build. |
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
