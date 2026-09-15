# Recover Scrape Redis Memory Stabilization Design

## Goal

Stop Redis from filling its 8 GB Railway memory limit while preserving active acquisition work, qualified leads, and the nationwide campaign. Redis becomes a short-lived coordination/state layer; Supabase remains the permanent lead store.

## Current failure mode

The acquisition worker stores full Google Maps CSV rows in `recover:acq:<id>:raw`. Those lists are rewritten after each round and inherit the same 604800-second (7-day) TTL as the acquisition job. In parallel, compact qualified results are stored in `recover:acq:<id>:results`, and qualified leads are duplicated into `recover:leadstore:qualified` plus campaign scope sets.

On 2026-09-14 around 22:58 UTC Redis started essentially empty. By 2026-09-15 around 15:00 UTC the persisted RDB reported about 7499.77 MB, and live memory reached about 7.99/8 GB. The controller then emitted repeated Redis connection timeouts and nationwide seeding stalled under backlog.

## Design

### 1. Raw acquisition data is ephemeral

`recover:acq:<id>:raw` exists only to support an acquisition while it is running or retrying.

- Default raw TTL: 2 hours (`7200` seconds), configurable with `ACQUISITION_RAW_TTL_SECONDS`.
- Every write to the raw list refreshes this short TTL.
- On terminal success states (`complete`, `partial_complete`) the raw list is deleted immediately after the terminal job state and coverage record have been persisted.
- On terminal failure the raw list keeps the short TTL so near-term debugging/retry remains possible.
- Shutdown/interruption requeues the job and keeps raw state for the short TTL.

### 2. Compact results are retained briefly

`recover:acq:<id>:results` contains compact leads and is much smaller than the raw Maps data.

- Default result TTL: 24 hours (`86400` seconds), configurable with `ACQUISITION_RESULT_TTL_SECONDS`.
- Result writes refresh this TTL.
- Results are not the permanent source of truth.

### 3. Supabase is the permanent lead store

The existing persistence path to Supabase remains the canonical durable store. Redis lead-store structures may remain temporarily for campaign dedupe/scope compatibility, but no new large raw payloads are treated as durable data.

No production cleanup may remove qualified lead data from Supabase.

### 4. Safe existing-data cleanup

Add a dedicated cleanup script that scans acquisition job IDs and deletes only oversized ephemeral layers that are safe to remove.

Safe cleanup rules:

- Never use `FLUSHDB` or `FLUSHALL`.
- Never delete active queue lists, lease keys, controller cursor/state, coverage state, campaign scope sets, or qualified lead hashes as part of this fix.
- For jobs in `complete` or `partial_complete`, delete `:raw` immediately.
- For `failed` jobs older than the configured raw TTL, delete `:raw`.
- For running/queued jobs, keep `:raw` but apply/refresh the short TTL.
- Optionally expire old `:results` using the configured result TTL; do not delete results for currently running jobs.
- Process in small batches and report freed-key counts so production can be observed between batches.

### 5. Avoid whole-store reads in hot paths

Do not add new `HVALS`/`HGETALL` operations over `recover:leadstore:qualified` to acquisition hot paths. Existing startup/bootstrap behavior should be moved away from whole-hash reads where practical; this fix may add a lighter stats/cleanup path without restructuring unrelated campaign behavior.

### 6. Worker recovery and scaling

After Redis memory is materially below the 8 GB Railway limit and controller connectivity has stabilized:

- Verify the controller reconnects and the active backlog starts draining.
- Restore missing acquisition-worker capacity gradually rather than jumping directly to 12 replicas.
- Observe Redis memory, queue depth, Maps lane health, and stored-lead throughput between scaling steps.
- Do not increase Redis capacity as the primary fix; extra RAM is only emergency headroom, not a substitute for lifecycle cleanup.

### 7. Verification criteria

The fix is successful when all of the following are true:

- Redis memory drops substantially below the Railway 8 GB limit and remains stable rather than regrowing toward the ceiling.
- Controller logs stop showing continuous Redis connection timeouts.
- Active acquisition queue drains toward its configured high-water level.
- Controller cursor resumes advancing.
- New qualified leads continue to persist to Supabase.
- Active acquisitions survive cleanup with their queue/lease/job state intact.
- Completed acquisitions no longer retain large `:raw` lists.

## Files expected to change

- `recover-mcp/acquisition-worker.mjs` — raw/result TTLs and terminal raw cleanup.
- `recover-mcp/acquisition-worker-runtime.mjs` — keep runtime patch compatibility if source snippets change.
- `recover-mcp/acquisition-worker-runtime.test.mjs` — runtime shim expectations.
- New `recover-mcp/cleanup-acquisition-redis.mjs` — safe cleanup logic.
- New `recover-mcp/cleanup-acquisition-redis.node-test.mjs` — cleanup behavior tests.
- Possibly `package.json` — add a cleanup/audit script if useful for controlled Railway execution.

## Safety constraints

- Preserve the live acquisition queues and controller state.
- Preserve Supabase lead data.
- No destructive Redis flush.
- Cleanup only state proven ephemeral by job status/age.
- Deploy code before running cleanup so new acquisitions stop recreating the same memory problem.
- Scale workers only after Redis stabilizes.
