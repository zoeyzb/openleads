# Nationwide Throughput and Sheets Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Increase safe nationwide acquisition throughput toward 100,000 strict no-website core-home-service leads and replace fragile `IMPORTDATA` syncing with idempotent Google Sheets API batch appends.

**Architecture:** Keep the current ZIP-based state/city/ZIP partitioner and Redis coverage claims, but derive controller queue/seed capacity from configured worker and Maps-lane capacity instead of hard 72/18 ceilings. Add deterministic shard metadata to new jobs without changing parked legacy queues. Add a separate Railway Sheets sync worker that reads the existing strict canonical Supabase result, compares stable Lead IDs with `Lead CRM`, appends only missing rows, verifies the IDs landed, then advances its checkpoint.

**Tech Stack:** Node.js ESM, Redis, Supabase/PostgREST, Google Sheets v4 API, Railway, node:test.

**Spec:** `docs/superpowers/specs/2026-09-11-nationwide-throughput-and-sheets-sync-design.md`

## Global Constraints

- Use the existing Google spreadsheet `1zdmwd_kCyruHlLMMuH8A9mAmaO3fSk8xJfO8-Ndbw6I`; do not create a second lead spreadsheet.
- Keep only strict no-website HVAC/heating/cooling/AC, plumbing, furnace/boiler, duct/ventilation, and refrigeration service/contractor leads with phone or email.
- Preserve canonical lead data and existing manual CRM fields.
- Do not manually overwrite `Live Auto Feed`.
- Do not apply Railway staged patch `57fdde22-fc5a-47b3-a2d0-cda24068c01d`.
- Preserve parked legacy queues/jobs and existing integrations.
- A Sheets checkpoint advances only after appended IDs are read back and verified.
- Missing Google service-account credentials must produce a safe idle state, never a destructive fallback.

---

### Task 1: Capacity-aware nationwide scheduler

**Files:**
- Create: `recover-mcp/nationwide-shard-scheduler.mjs`
- Create: `recover-mcp/nationwide-shard-scheduler.test.mjs`
- Modify: `recover-mcp/us-hvac-controller.mjs`

**Interfaces:**
- Produces: `deriveSchedulerCapacity({ workerCount, mapsLaneCount, queueHighWater, seedBatchSize }) -> { workerCount, mapsLaneCount, queueHighWater, seedBatchSize, shardCount }`
- Produces: `shardIdForArea(area, shardCount) -> string`

- [ ] Write tests asserting 4 workers + 6 Maps lanes defaults to queue high-water 144, seed batch 36, deterministic shard IDs, explicit lower overrides are respected, and unsafe values are clamped.
- [ ] Run `node --test recover-mcp/nationwide-shard-scheduler.test.mjs` and confirm the missing module fails.
- [ ] Implement the pure scheduler helper with safe clamps (`queueHighWater <= 288`, `seedBatchSize <= 72`) and deterministic ZIP/state hashing.
- [ ] Update `us-hvac-controller.mjs` to consume `US_HVAC_WORKER_COUNT` and `US_HVAC_MAPS_LANE_COUNT`, remove the old hard 72/18 caps, include `shard_id` on new jobs/coverage metadata, and emit capacity telemetry while leaving parked-queue semantics unchanged.
- [ ] Run `node --test recover-mcp/*.test.mjs` and confirm all recover-mcp tests pass.

### Task 2: Strict Sheets API sync worker

**Files:**
- Create in the deployed sheet-sync source tree: `scripts/google-sheets-sync.mjs`
- Create: `scripts/google-sheets-sync.test.mjs`

**Interfaces:**
- Consumes canonical strict Supabase rows using the same qualification source as the existing sheet feed.
- Produces an append-only delta to `Lead CRM!A:Y`.
- Uses stable Lead ID as the first dedupe key and verifies written IDs before checkpoint advancement.

- [ ] Inspect the existing sheet-feed source and identify its exact canonical Supabase view/query and row mapping.
- [ ] Write unit tests for CRM row mapping, preservation of manual-field blanks/default `New`, stable-ID dedupe, checkpoint non-advancement on failed verification, and safe idle on missing `GOOGLE_SERVICE_ACCOUNT_JSON`.
- [ ] Implement service-account OAuth JWT exchange with Node `crypto` and Google Sheets v4 REST calls; do not add a Google SDK dependency unless the repo already uses it.
- [ ] Read existing Lead IDs from column A, fetch canonical rows after the persisted checkpoint, filter existing IDs, append in batches of 250–500, reread the appended range/IDs, and advance checkpoint only after verification.
- [ ] Run the worker tests and the repository's existing test suite relevant to the new script.

### Task 3: Railway deployment without staged-patch interference

**Files:**
- No source mutation outside Tasks 1–2.

- [ ] Deploy the controller source changes through its existing GitHub source; do not apply the staged Railway patch.
- [ ] Set `US_HVAC_WORKER_COUNT=4`, `US_HVAC_MAPS_LANE_COUNT=6`, and capacity settings consistent with the tested 144/36 defaults.
- [ ] Verify controller, four acquisition workers, and six Maps lanes are healthy; verify cursor advances and queue does not remain pinned/stalled.
- [ ] Create a separate `recover-google-sheets-sync` Railway service from the confirmed sheet-sync repository/branch with a 5-minute cron or equivalent one-shot schedule.
- [ ] Configure non-secret Sheets/Supabase settings. If `GOOGLE_SERVICE_ACCOUNT_JSON` is absent, verify the service exits/idle safely and report that exact external credential blocker rather than claiming autonomous sync.

### Task 4: End-to-end verification

- [ ] Query Supabase for the strict canonical count and compare it with unique populated Lead IDs in `Lead CRM`.
- [ ] Verify no duplicate Lead IDs were appended and existing manual CRM fields were not overwritten.
- [ ] Verify the Recover Scrape Railway staged patch remains STAGED and untouched.
- [ ] Recheck controller queue/cursor and deployment health after the capacity change.
- [ ] Report the exact canonical lead count, exact sheet count, scheduler capacity, and whether Google service-account auth is active or still the only blocker.
