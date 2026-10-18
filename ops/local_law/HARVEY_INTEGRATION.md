# Harvey + OpenLeads: local ChatGPT/Codex integration

Last audited: October 19, 2026. Harvey is MIT-licensed upstream software
cloned into an isolated vendor directory, NOT merged into the OpenLeads code.

## Eligibility contract

Only the original OpenLeads law_local.worker strict export may determine
the count of qualified law-firm leads. Each needs an operating law practice,
a matching published phone, source-proven 2–10 attorneys firmwide, no
attributable owned website independently screened against working search
providers, and a source-published usable email. An empty OSM/Maps website
field is UNKNOWN, not proof a website does not exist. An AI-generated guess
cannot upgrade research to a qualified lead.

## Installed Mac structure

- Main repository: ~/lead-workspace/openleads
- Vendor source: ~/lead-workspace/openleads-vendors/harvey
- Harvey virtualenv: vendor/.venv (Python 3.11)
- Harvey-only Codex CLI: vendor/.harvey-codex-cli, version 0.159.3
- Existing main Codex CLI: ~/.npm-global/bin/codex, version 0.163.0 (unchanged)
- Harvey private DB: vendor/data/harvey.db
- OpenLeads primary DB: ~/lead-workspace/law-leads.sqlite3
- OpenLeads research DB: ~/lead-workspace/research_catalog.sqlite3
- Bridge: ops/local_law/harvey_bridge.py
- Sidecar: ops/local_law/harvey_sidecar.py
- Wrapper: ops/local_law/harvey_local.sh

The Harvey configuration uses brain.provider=codex, an account-selected
model, and at most 25 percent of the observed subscription quota.
Both email and LinkedIn channels are disabled. The daily mail limit is 0.
No Harvey autonomous run, sender, reply handler or campaigns are started.

## Account login (one user action needed)

The native Codex CLI reports ChatGPT login with owner-only file permissions.
But the last token refresh is September 16, 2026; Harvey's security preflight
rejected the expired login, and a native Codex refresh failed. To finish
connection, the account owner must run on their Mac:

    ~/.npm-global/bin/codex login

Complete the official ChatGPT browser sign-in. Then verify, from OpenLeads:

    sh ops/local_law/harvey_local.sh status --check
    /opt/homebrew/bin/python3.11 -m ops.local_law.harvey_bridge doctor

No OpenAI API key is needed. No credentials or login tokens were copied
to OpenLeads or checked into GitHub.

## Working commands

    # Sync only CURRENT strict-eligible firms from canonical SQLite:
    /opt/homebrew/bin/python3.11 -m ops.local_law.harvey_bridge sync-strict

    # Optional free OSM office=lawyer discovery, RESEARCH ONLY:
    /opt/homebrew/bin/python3.11 -m ops.local_law.harvey_bridge discover-osm --city chicago --max 25

    # Local Harvey UI, no public listener, no autonomous mail sender:
    sh ops/local_law/harvey_local.sh dashboard --host 127.0.0.1 --port 5555

    # Regression suites:
    /opt/homebrew/bin/python3.11 -m unittest ops.local_law.test_harvey_bridge -q
    /opt/homebrew/bin/python3.11 -m unittest discover -s law_local -q
    /opt/homebrew/bin/python3.11 -m unittest discover -s ops/local_law -q

The Mac hourly campaign calls ONLY the strict mirror; it does not launch
Harvey's autonomous sales loop. The mirror imports eligible law firms as
Harvey Companies. Published business emails are private company metadata;
prospects are not invented when no linked named human is evidenced.
Re-sync is idempotent, and a revoked strict lead is marked withdrawn.
Three strict companies were imported live; zero contacts, campaigns,
outbox messages or outbound deliveries were created.

## OSM upstream limitation and recovery

Harvey's real OpenStreetMap collector runs in its isolated venv, adapted
to return bounded public law-office listings to OpenLeads. Source records
are held with origin and timestamps. Blank website listings enter the
existing unverified map-headcount research stage ONLY, never qualified.
Explicit website evidence remains on hold even if later OSM data omits
the website field. Existing phone/name research IDs are deduplicated.

Public Overpass instances returned HTTP 406/500 from the actual Mac.
Although a few tiny probes returned HTTP 200, bounded full queries
failed. Automatic Harvey OSM source runs remain DISABLED; even if the
HARVEY_OSM_AUTOMATIC environment flag is enabled later, errors result
in a six-hour retry cooldown and zero qualification claims.
The community Overpass API is not an unlimited hosted substitute.
No paid service or rate-limit workaround is installed.

## Reproduction and rollback

After a fresh shallow Harvey clone, install the supported Codex version
in its own local npm prefix; make a Python 3.11 venv and install Harvey
editable within that venv. Preserve the local research-only config; do
not enable email/LinkedIn or launch the autonomous run until explicitly
authorized. Set vendor/data permission 0700 and harvey.db permission
0600. To stop integration, remove the hourly harvey_cycle calls or
restore the campaign backup on the Mac. Do not delete canonical leads.

The main OpenLeads repository's license is unchanged; Harvey retains its
own MIT license. No prospect data is pushed into either public repository.
