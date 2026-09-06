# Recover Scrape MCP

Unified remote MCP gateway for Recover Revenue scraping and lead research.

## Live endpoint

- MCP: https://recover-scrape-mcp-production.up.railway.app/mcp
- Health: https://recover-scrape-mcp-production.up.railway.app/health

## ChatGPT OAuth

The gateway keeps legacy bearer-token access and also supports an OAuth 2.1 authorization-code flow with PKCE for ChatGPT custom apps.

Required production variables:

- `OAUTH_ISSUER`: public HTTPS origin of this service
- `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET`: credentials entered in ChatGPT's User-Defined OAuth Client settings
- `OAUTH_SIGNING_SECRET`: private HMAC key used to sign short-lived authorization codes and tokens
- `OAUTH_ACCESS_KEY`: private key the owner enters on the Recover Scrape authorization page

Never store these values in the repository. OAuth access tokens expire after one hour; refresh tokens expire after 30 days. Existing `MCP_AUTH_TOKEN` bearer clients remain supported.

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
