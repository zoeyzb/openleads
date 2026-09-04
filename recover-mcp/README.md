# Recover Scrape MCP

Unified remote MCP gateway for Recover Revenue scraping and lead research.

## Live endpoint

- MCP: https://recover-scrape-mcp-production.up.railway.app/mcp
- Health: https://recover-scrape-mcp-production.up.railway.app/health

## Railway backends

- Gosom Google Maps Scraper: https://maps-gosom-production.up.railway.app
- Crawl4AI: https://crawl4ai-production-5d03.up.railway.app

## MCP tools

- `recover_scrape_status`
- `maps_start_job`
- `maps_job_status`
- `crawl_website`
- `enrich_email`
- `dedupe_leads`
- `qualify_leads`
- `research_and_qualify`

## Source repos used

Runtime:
- zoeyzb/google-maps-scraper
- zoeyzb/crawl4ai
- zoeyzb/email-enrich
- zoeyzb/openleads (gateway host)

Qualification/reference layer:
- zoeyzb/gtm-signal-scoring
- zoeyzb/gtm-skills
- zoeyzb/LeadQualifier
- zoeyzb/ai-lead-scoring-qualification

Deduplication/reference layer:
- zoeyzb/dedupe

Other forked scraper implementations can remain fallbacks/alternatives rather than being loaded into the same process. The gateway is intentionally the only MCP ChatGPT should connect to.

## Verification

Verified externally:
- Recover MCP health returns HTTP 200.
- Gosom /api/v1/jobs returns HTTP 200.
- Crawl4AI /health returns HTTP 200.
- Crawl4AI protected /crawl requires authentication.
- Recover /mcp rejects ordinary GET requests with MCP JSON-RPC Method Not Allowed, confirming the remote MCP handler is live.

## Design rule

Do not merge all upstream projects into one runtime. Keep heavyweight scrapers isolated and route through the gateway. This avoids dependency conflicts and lets one backend fail without taking down the whole MCP.
