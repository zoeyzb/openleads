# Nationwide Throughput and Google Sheets Sync Design

## Goal

Reach 100,000 strict, unique, no-website core home-service leads nationwide without geographic blind spots, repeated work, or Google Sheets `IMPORTDATA` failures.

## Scope

This design changes two connected subsystems only:

1. Nationwide acquisition scheduling and coverage management.
2. Incremental Google Sheets synchronization from the canonical strict Supabase view.

It preserves the existing acquisition workers, Maps lanes, Redis queues, Supabase lead storage, strict targeting rules, parked legacy jobs, and the single existing Google Sheet.

## Non-goals

- Do not create a second lead spreadsheet.
- Do not delete canonical lead data.
- Do not reactivate parked legacy jobs.
- Do not accept or deploy Railway's unrelated staged patch.
- Do not replace the working Maps/Overpass/search acquisition stack.
- Do not use `IMPORTDATA` as the production sync mechanism.

## Canonical lead rules

Only leads meeting all of these conditions may flow to the CRM:

- Industry fit: HVAC, heating, cooling, AC, plumbing, furnace, boiler, duct, ventilation, refrigeration service/contractor.
- No website.
- At least one contact method: public phone or email.
- Reject unrelated auto, pest, appliance, wholesale, supplier, distributor, retail, manufacturer, general contractor/construction, roofing, landscaping, and similar junk.
- Canonical dedupe order: normalized phone, then normalized email, then stable place identity/name+address fallback.

Supabase remains the source of truth. The spreadsheet is an output/CRM projection.

## Existing nationwide controller behavior

The current `recover-mcp/us-hvac-controller.mjs` already loads a national ZIP dataset and partitions coverage by state, city, and ZIP. It also persists a controller cursor and coverage pass in Redis and uses `claimCoverage` to prevent duplicate geographic work.

The current throughput limit comes from conservative hard caps: queue high-water 72, seed batch 18, target per ZIP 18, depth 6, and one round per ZIP. The replacement keeps the existing partitioning concept but changes scheduling from fixed caps to adaptive shard scheduling.

## Acquisition architecture

### Geographic work units

The atomic work unit remains a ZIP-level coverage unit with stable fields:

- `partition_state`
- `partition_city`
- `partition_zip`
- `coverage_pass`
- `source_population`

ZIPs are grouped into deterministic logical shards so multiple workers can operate on disjoint geography concurrently. Shard identity must be stable across restarts and derived from geography, not from runtime ordering.

### Durable coverage state

For each ZIP work unit, persist state sufficient to distinguish:

- unseen
- queued
- running
- completed
- exhausted
- retryable failure

Coverage state must include at least:

- unique leads produced
- raw leads observed
- duplicate count when available
- failure count
- last attempt timestamp
- coverage pass
- shard id

`claimCoverage` remains the gate that prevents accidental duplicate work.

### Adaptive scheduler

The controller should fill available acquisition capacity from uncovered or retryable work rather than using a single fixed queue ceiling.

Capacity is derived from healthy acquisition workers and healthy Maps lanes, with an explicit maximum safety cap. The scheduler should:

1. Prefer unseen ZIPs.
2. Keep active work distributed across states rather than draining one state at a time.
3. Prefer higher-population uncovered ZIPs within each state/city wave.
4. Retire ZIPs that repeatedly produce low unique yield.
5. Retry transient failures with bounded attempts.
6. Continue into additional coverage passes only after the first pass is exhausted and the 100,000 target is unmet.

A high-yield ZIP must not cause the same ZIP to be re-enqueued immediately; follow-on work should come from neighboring or same-market uncovered ZIPs, preserving geographic uniqueness.

### Backpressure

Backpressure remains mandatory. The scheduler may only enqueue up to computed free capacity. It must never flood Redis with unbounded work.

The computed queue target should be based on current healthy lane/worker count and configurable jobs-per-lane, with a hard maximum. If health information is unavailable, fall back to the current conservative behavior.

### Compatibility

Existing queued v2 jobs remain valid. Existing parked legacy queues remain parked. No migration should invalidate in-flight jobs.

## Google Sheets sync architecture

### Data flow

Production flow:

`Supabase strict view -> durable checkpoint -> fetch new canonical leads -> dedupe against sheet IDs -> Google Sheets API batch append -> reread/verify appended IDs -> advance checkpoint`

### Single spreadsheet

Use only the existing spreadsheet:

`1zdmwd_kCyruHlLMMuH8A9mAmaO3fSk8xJfO8-Ndbw6I`

Primary destination remains `Lead CRM`.

### Checkpoint semantics

The sync worker keeps a durable checkpoint outside Google Sheets. The checkpoint must not advance until appended rows have been verified in the destination sheet.

Checkpoint ordering should use a stable tuple, preferably `(discovered_at, id)`, so rows sharing the same timestamp cannot be skipped.

On restart or partial failure:

1. Read the existing checkpoint.
2. Read the relevant sheet IDs for the candidate batch.
3. Skip IDs already present.
4. Append only missing rows.
5. Verify the appended IDs by reading them back.
6. Advance the checkpoint only after verification succeeds.

This makes retries idempotent.

### Sheet write behavior

Use Google Sheets API batch writes in bounded chunks, initially 250-500 rows per request.

For existing Lead IDs:

- Never overwrite manual CRM workflow fields.
- Do not duplicate the row.

For new Lead IDs:

- Populate canonical source fields.
- Default Lead Status to `New`.
- Leave owner/contact and other manual workflow columns empty unless canonical data explicitly provides them.

The sync worker must never rebuild or clear the full sheet as part of normal operation.

### Verification

Every successful batch must verify:

- expected IDs exist in `Lead CRM`
- actual appended row count matches missing-ID count
- no duplicate Lead IDs were introduced
- checkpoint only moved after those checks

A failed verification leaves the checkpoint unchanged and is safe to retry.

## Google authentication

Railway must authenticate independently through a dedicated Google service account.

Required setup:

1. Create a Google Cloud service account with Sheets API access.
2. Share the existing CRM spreadsheet with the service-account email as Editor.
3. Store the service-account credential in Railway as a secret environment variable; do not commit credentials to Git.
4. The sync worker parses the credential at runtime and requests only the scopes needed for Google Sheets writes.

The implementation should support a single JSON credential variable, e.g. `GOOGLE_SERVICE_ACCOUNT_JSON`, plus `GOOGLE_SHEETS_SPREADSHEET_ID` and `GOOGLE_SHEETS_SHEET_NAME`.

The worker must fail closed if credentials are missing or malformed. It must never fall back to public `IMPORTDATA`.

## Failure handling

### Acquisition

- Transient worker/Maps failures: retry bounded times.
- Repeated low-yield ZIPs: mark exhausted for the current pass.
- Redis/controller restart: resume from durable coverage state and cursor.
- Missing health telemetry: use conservative queue capacity.

### Sheets sync

- Google 429/5xx: exponential backoff with jitter; do not advance checkpoint.
- Auth failure: stop writes, log a clear configuration error, do not mutate checkpoint.
- Partial append/timeout: verify IDs before retrying.
- Supabase query failure: do not write or advance checkpoint.

## Observability

Controller logs should expose:

- strict clean count
- queue length
- active/healthy worker count
- active/healthy Maps lane count
- computed queue target
- cursor / coverage pass
- current state/city/ZIP or shard
- per-cycle seeded count
- unique yield by completed shard or ZIP where available

Sheets sync logs should expose:

- checkpoint before/after
- candidate count
- existing-ID skips
- appended count
- verified count
- retry/error reason

No secret values may be logged.

## Deployment safety

- Implement and test on the existing `recover-scrape-mcp` branch.
- Keep Railway's currently staged unrelated patch untouched.
- Do not deploy the staged patch as part of these changes.
- Deploy only the controller and new sync-worker service/config required by this design.
- Verify current Maps lanes and acquisition workers remain healthy after deployment.

## Acceptance criteria

1. Nationwide work remains disjoint by stable ZIP-based coverage identity.
2. Controller can keep multiple uncovered geographic shards in flight concurrently.
3. Queue target adapts to healthy capacity while retaining a hard safety limit.
4. Completed/exhausted ZIPs are not immediately re-run.
5. Canonical strict lead count continues increasing without quality-rule regression.
6. Google Sheets sync does not use `IMPORTDATA`.
7. New canonical leads are appended incrementally to the one existing `Lead CRM` sheet.
8. Existing Lead IDs are not duplicated.
9. Manual CRM fields on existing rows are preserved.
10. Checkpoint advances only after Sheets verification succeeds.
11. Missing Google credentials cause a clean configuration failure, not silent data loss.
12. Railway staged unrelated changes remain untouched.
13. Existing integrations and parked legacy jobs remain preserved.
