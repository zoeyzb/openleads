# External acquisition sources

Recover should treat lead sources as adapters, not as separate permanent workers.

## Sources

### Native Google Maps scraper
Primary high-volume source. Keep the existing acquisition/qualification/dedupe pipeline.

### Outscraper
Optional API fallback and coverage filler. Configure `OUTSCRAPER_API_KEY`.
The adapter uses the Google Maps search API and normalizes records into the same Recover lead shape.

### SmartScraper
SmartScraper currently exposes a Chrome extension with CSV export rather than a public automation API.
Use its CSV output as an import source. `normalizeSmartScraperCsv()` maps its export columns to Recover's canonical lead shape.

## Target runtime topology

Always-on:
1. recover-control-api
2. recover-acquisition-worker

Short-lived / scheduled:
- seeding and coverage planning
- dedupe audits
- raw reprocessing
- imports
- maintenance
- validation tests

Do not provision one permanent service per worker letter or Maps lane. Use concurrency inside the acquisition worker and a bounded pool of scraper processes. Scale horizontally only when queue latency or CPU/memory proves it is necessary.

## Source policy

1. Native scraper first.
2. SmartScraper CSV imports are opportunistic/free.
3. Outscraper is fallback for failed/low-yield coverage, or urgent small batches.
4. Every source passes through the same normalization, dedupe, target qualification and persistence path.
5. Preserve `source` on every lead for yield/cost tracking.
