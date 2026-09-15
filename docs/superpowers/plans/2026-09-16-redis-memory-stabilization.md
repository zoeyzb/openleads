# Recover Scrape Redis Memory Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Recover Scrape Redis from retaining multi-gigabyte raw acquisition payloads, safely reclaim existing ephemeral Redis memory, and restore stable nationwide acquisition throughput without losing active jobs or durable Supabase leads.

**Architecture:** Raw Google Maps acquisition rows become short-lived Redis working state, compact result lists get a shorter retention period than jobs, and terminal successful jobs immediately delete raw payloads. A dedicated cleanup script reclaims only status-proven ephemeral data in small batches. Production rollout deploys lifecycle fixes first, then cleans existing data, verifies controller recovery, and only then restores worker capacity gradually.

**Tech Stack:** Node.js ESM, `redis` npm client, Railway, Supabase, existing Recover Scrape worker/controller code, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-16-redis-memory-stabilization-design.md`

## Global Constraints

- Preserve the live acquisition queues and controller state.
- Preserve Supabase lead data.
- Never run `FLUSHDB` or `FLUSHALL`.
- Deploy lifecycle fixes before cleaning existing Redis data.
- Default raw TTL is 7200 seconds unless overridden by `ACQUISITION_RAW_TTL_SECONDS`.
- Default compact result TTL is 86400 seconds unless overridden by `ACQUISITION_RESULT_TTL_SECONDS`.
- Cleanup only state proven ephemeral by job status/age.
- Scale workers only after Redis memory and controller connectivity stabilize.

---

### Task 1: Make Redis list retention type-specific

**Files:**
- Modify: `recover-mcp/acquisition-worker.mjs`
- Test: `recover-mcp/acquisition-worker-lifecycle.node-test.mjs`

**Interfaces:**
- Consumes: existing Redis client and `JOB_TTL` worker configuration.
- Produces: `RAW_TTL_SECONDS`, `RESULT_TTL_SECONDS`, `replaceList(key, values, ttlSeconds)`, `deleteRawForJob(id)`.

- [ ] **Step 1: Write the failing lifecycle test**

Create `recover-mcp/acquisition-worker-lifecycle.node-test.mjs` with source-level assertions that the worker defines separate raw/result TTL environment variables and does not hard-code `JOB_TTL` inside generic list replacement:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./acquisition-worker.mjs", import.meta.url), "utf8");

test("worker defines short raw and result TTLs", () => {
  assert.match(source, /ACQUISITION_RAW_TTL_SECONDS\s*\|\|\s*7200/);
  assert.match(source, /ACQUISITION_RESULT_TTL_SECONDS\s*\|\|\s*86400/);
});

test("replaceList receives an explicit TTL", () => {
  assert.match(source, /async function replaceList\(key,values,ttlSeconds\)/);
  assert.match(source, /await redis\.expire\(key,ttlSeconds\)/);
});

test("raw and results use their own TTLs", () => {
  assert.match(source, /replaceList\(rawKey\(id\),allRaw,RAW_TTL_SECONDS\)/);
  assert.match(source, /replaceList\(resultsKey\(id\),persisted,RESULT_TTL_SECONDS\)/);
});
```

- [ ] **Step 2: Run the test and verify failure**

Run:

```bash
node --test recover-mcp/acquisition-worker-lifecycle.node-test.mjs
```

Expected: FAIL because the current worker only has `JOB_TTL` and `replaceList(key, values)`.

- [ ] **Step 3: Add explicit raw/result TTL configuration**

In `recover-mcp/acquisition-worker.mjs`, next to `JOB_TTL`, add:

```js
const RAW_TTL_SECONDS = Math.max(300, Number(process.env.ACQUISITION_RAW_TTL_SECONDS || 7200));
const RESULT_TTL_SECONDS = Math.max(3600, Number(process.env.ACQUISITION_RESULT_TTL_SECONDS || 86400));
```

Change list replacement to:

```js
async function replaceList(key, values, ttlSeconds) {
  await redis.del(key);
  for (let i = 0; i < values.length; i += 200) {
    const chunk = values.slice(i, i + 200).map(x => JSON.stringify(x));
    if (chunk.length) await redis.rPush(key, chunk);
  }
  if (values.length) await redis.expire(key, ttlSeconds);
}
```

Update every raw list write to:

```js
await replaceList(rawKey(id), allRaw, RAW_TTL_SECONDS);
```

Update every results list write to:

```js
await replaceList(resultsKey(id), persisted, RESULT_TTL_SECONDS);
```

For final result slices use:

```js
await replaceList(resultsKey(id), finalLeads, RESULT_TTL_SECONDS);
```

- [ ] **Step 4: Run the lifecycle test**

Run:

```bash
node --test recover-mcp/acquisition-worker-lifecycle.node-test.mjs
```

Expected: PASS.

- [ ] **Step 5: Run existing worker/runtime tests**

Run:

```bash
node --test recover-mcp/acquisition-worker-runtime.test.mjs recover-mcp/acquisition-persistence.node-test.mjs recover-mcp/acquisition-coverage.node-test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add recover-mcp/acquisition-worker.mjs recover-mcp/acquisition-worker-lifecycle.node-test.mjs
git commit -m "fix: bound acquisition Redis list retention"
```

---

### Task 2: Delete raw payloads on successful terminal states

**Files:**
- Modify: `recover-mcp/acquisition-worker.mjs`
- Modify: `recover-mcp/acquisition-worker-lifecycle.node-test.mjs`

**Interfaces:**
- Consumes: `rawKey(id)`, Redis client, existing terminal branches.
- Produces: `deleteRawForJob(id): Promise<void>` invoked only after terminal job and coverage state are persisted.

- [ ] **Step 1: Extend the failing lifecycle test**

Add:

```js
test("successful terminal jobs delete raw payloads", () => {
  assert.match(source, /async function deleteRawForJob\(id\)/);
  assert.match(source, /await redis\.del\(rawKey\(id\)\)/);
  const calls = source.match(/await deleteRawForJob\(id\)/g) || [];
  assert.ok(calls.length >= 3, `expected terminal cleanup calls, got ${calls.length}`);
});
```

- [ ] **Step 2: Run the test and verify failure**

```bash
node --test recover-mcp/acquisition-worker-lifecycle.node-test.mjs
```

Expected: FAIL because no terminal raw cleanup exists.

- [ ] **Step 3: Implement raw cleanup helper**

Add beside key helpers:

```js
async function deleteRawForJob(id) {
  try {
    await redis.del(rawKey(id));
  } catch (error) {
    console.warn("Acquisition raw cleanup failed", id, error.message);
  }
}
```

In every successful terminal branch, call it only after `saveJob(job)` and `markCoverage(...)` complete. Specifically add it before return/end for:

```js
job.status = "complete";
```

and both `partial_complete` paths (`stagnant_round_exit` and `max_rounds_reached`).

Do not delete raw state in the `failed` or `interrupted_requeued` branches.

- [ ] **Step 4: Run lifecycle and existing tests**

```bash
node --test recover-mcp/acquisition-worker-lifecycle.node-test.mjs recover-mcp/acquisition-worker-runtime.test.mjs recover-mcp/acquisition-persistence.node-test.mjs recover-mcp/acquisition-coverage.node-test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add recover-mcp/acquisition-worker.mjs recover-mcp/acquisition-worker-lifecycle.node-test.mjs
git commit -m "fix: release raw Redis payloads after acquisition completion"
```

---

### Task 3: Keep the Railway runtime shim compatible

**Files:**
- Modify if needed: `recover-mcp/acquisition-worker-runtime.mjs`
- Modify: `recover-mcp/acquisition-worker-runtime.test.mjs`

**Interfaces:**
- Consumes: exact source snippets from `acquisition-worker.mjs` patched at runtime.
- Produces: runtime patcher that still transforms the worker exactly once without throwing snippet-count errors.

- [ ] **Step 1: Run the runtime test against the modified worker**

```bash
node --test recover-mcp/acquisition-worker-runtime.test.mjs
```

Expected: either PASS, or FAIL with an exact legacy snippet mismatch if lifecycle edits changed a patched source block.

- [ ] **Step 2: If a snippet mismatch occurs, update only the affected runtime constants**

Preserve the semantic transformations already present: resilient Maps wait, adaptive cooldown, retryable Maps status handling, and concurrent worker loop. Do not duplicate lifecycle logic in the shim.

- [ ] **Step 3: Strengthen the runtime test**

Add an assertion that `patchAcquisitionWorkerSource()` preserves the new TTL and raw-cleanup strings from the base source:

```js
assert.match(patched, /ACQUISITION_RAW_TTL_SECONDS/);
assert.match(patched, /deleteRawForJob/);
```

- [ ] **Step 4: Run runtime test**

```bash
node --test recover-mcp/acquisition-worker-runtime.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit only if files changed**

```bash
git add recover-mcp/acquisition-worker-runtime.mjs recover-mcp/acquisition-worker-runtime.test.mjs
git commit -m "test: keep worker runtime patch compatible with Redis lifecycle"
```

---

### Task 4: Add a safe Redis cleanup module

**Files:**
- Create: `recover-mcp/acquisition-redis-cleanup.mjs`
- Create: `recover-mcp/acquisition-redis-cleanup.node-test.mjs`

**Interfaces:**
- Consumes: job JSON, current time, raw TTL, result TTL.
- Produces: pure function `cleanupDecision(job, { nowMs, rawTtlSeconds, resultTtlSeconds })` returning `{ deleteRaw, expireRawSeconds, expireResultsSeconds, reason }`.

- [ ] **Step 1: Write failing unit tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { cleanupDecision } from "./acquisition-redis-cleanup.mjs";

const NOW = Date.parse("2026-09-16T00:00:00Z");

function job(status, updatedAt) {
  return { status, updated_at: updatedAt };
}

test("complete jobs delete raw and retain results briefly", () => {
  assert.deepEqual(
    cleanupDecision(job("complete", "2026-09-15T23:59:00Z"), { nowMs:NOW, rawTtlSeconds:7200, resultTtlSeconds:86400 }),
    { deleteRaw:true, expireRawSeconds:null, expireResultsSeconds:86400, reason:"terminal_success" }
  );
});

test("partial complete jobs delete raw", () => {
  assert.equal(cleanupDecision(job("partial_complete", "2026-09-15T23:59:00Z"), { nowMs:NOW, rawTtlSeconds:7200, resultTtlSeconds:86400 }).deleteRaw, true);
});

test("fresh queued jobs retain raw with short TTL", () => {
  assert.deepEqual(
    cleanupDecision(job("queued", "2026-09-15T23:30:00Z"), { nowMs:NOW, rawTtlSeconds:7200, resultTtlSeconds:86400 }),
    { deleteRaw:false, expireRawSeconds:7200, expireResultsSeconds:86400, reason:"active_or_retryable" }
  );
});

test("old failed jobs delete raw", () => {
  assert.equal(cleanupDecision(job("failed", "2026-09-15T20:00:00Z"), { nowMs:NOW, rawTtlSeconds:7200, resultTtlSeconds:86400 }).deleteRaw, true);
});

test("fresh failed jobs keep raw for debugging", () => {
  assert.equal(cleanupDecision(job("failed", "2026-09-15T23:30:00Z"), { nowMs:NOW, rawTtlSeconds:7200, resultTtlSeconds:86400 }).deleteRaw, false);
});
```

- [ ] **Step 2: Run and verify failure**

```bash
node --test recover-mcp/acquisition-redis-cleanup.node-test.mjs
```

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement pure cleanup policy**

Create `recover-mcp/acquisition-redis-cleanup.mjs`:

```js
function ageSeconds(job, nowMs) {
  const updated = Date.parse(job?.updated_at || job?.completed_at || job?.started_at || job?.created_at || 0);
  if (!Number.isFinite(updated) || updated <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((nowMs - updated) / 1000));
}

export function cleanupDecision(job, {
  nowMs = Date.now(),
  rawTtlSeconds = 7200,
  resultTtlSeconds = 86400
} = {}) {
  const status = String(job?.status || "").toLowerCase();
  if (["complete", "partial_complete"].includes(status)) {
    return { deleteRaw:true, expireRawSeconds:null, expireResultsSeconds:resultTtlSeconds, reason:"terminal_success" };
  }
  if (["failed", "error"].includes(status) && ageSeconds(job, nowMs) >= rawTtlSeconds) {
    return { deleteRaw:true, expireRawSeconds:null, expireResultsSeconds:resultTtlSeconds, reason:"failed_raw_expired" };
  }
  return { deleteRaw:false, expireRawSeconds:rawTtlSeconds, expireResultsSeconds:resultTtlSeconds, reason:"active_or_retryable" };
}
```

- [ ] **Step 4: Run unit tests**

```bash
node --test recover-mcp/acquisition-redis-cleanup.node-test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add recover-mcp/acquisition-redis-cleanup.mjs recover-mcp/acquisition-redis-cleanup.node-test.mjs
git commit -m "feat: define safe acquisition Redis cleanup policy"
```

---

### Task 5: Add controlled cleanup CLI

**Files:**
- Create: `recover-mcp/cleanup-acquisition-redis.mjs`
- Modify: `package.json`
- Test: `recover-mcp/acquisition-redis-cleanup.node-test.mjs`

**Interfaces:**
- Consumes: `cleanupDecision`, `ACQUISITION_REDIS_URL`, `ACQUISITION_RAW_TTL_SECONDS`, `ACQUISITION_RESULT_TTL_SECONDS`, optional `CLEANUP_BATCH_SIZE`, optional `CLEANUP_DRY_RUN`.
- Produces: a CLI that scans `recover:acq:index`, never flushes Redis, mutates only `recover:acq:<id>:raw` and TTLs of `:raw`/`:results`, and prints JSON batch summaries.

- [ ] **Step 1: Add a testable key guard**

Extend `acquisition-redis-cleanup.mjs` with:

```js
export function ephemeralKeysForJob(id) {
  const safeId = String(id || "").trim();
  if (!safeId) throw new Error("job id required");
  return {
    job:`recover:acq:${safeId}`,
    raw:`recover:acq:${safeId}:raw`,
    results:`recover:acq:${safeId}:results`
  };
}
```

Add tests asserting these are the only keys returned and no queue/controller/leadstore key names occur.

- [ ] **Step 2: Run test and verify failure, then implement helper**

```bash
node --test recover-mcp/acquisition-redis-cleanup.node-test.mjs
```

Expected before implementation: FAIL. After helper implementation: PASS.

- [ ] **Step 3: Create cleanup CLI**

Implement `recover-mcp/cleanup-acquisition-redis.mjs` to:

```js
import { createClient } from "redis";
import { cleanupDecision, ephemeralKeysForJob } from "./acquisition-redis-cleanup.mjs";

const REDIS_URL = process.env.ACQUISITION_REDIS_URL || process.env.REDIS_URL || "";
if (!REDIS_URL) throw new Error("ACQUISITION_REDIS_URL required");

const RAW_TTL_SECONDS = Math.max(300, Number(process.env.ACQUISITION_RAW_TTL_SECONDS || 7200));
const RESULT_TTL_SECONDS = Math.max(3600, Number(process.env.ACQUISITION_RESULT_TTL_SECONDS || 86400));
const BATCH_SIZE = Math.min(500, Math.max(10, Number(process.env.CLEANUP_BATCH_SIZE || 100)));
const DRY_RUN = String(process.env.CLEANUP_DRY_RUN || "1") !== "0";

const redis = createClient({ url:REDIS_URL });
redis.on("error", error => console.error("Redis error", error));
await redis.connect();

const ids = await redis.sMembers("recover:acq:index");
let scanned = 0, rawDeleted = 0, rawExpired = 0, resultsExpired = 0, missingJobs = 0;

for (let offset = 0; offset < ids.length; offset += BATCH_SIZE) {
  const batch = ids.slice(offset, offset + BATCH_SIZE);
  for (const id of batch) {
    scanned++;
    const keys = ephemeralKeysForJob(id);
    const rawJob = await redis.get(keys.job);
    if (!rawJob) { missingJobs++; continue; }
    let job;
    try { job = JSON.parse(rawJob); } catch { continue; }
    const decision = cleanupDecision(job, { rawTtlSeconds:RAW_TTL_SECONDS, resultTtlSeconds:RESULT_TTL_SECONDS });
    if (!DRY_RUN) {
      if (decision.deleteRaw) rawDeleted += await redis.del(keys.raw);
      else if (await redis.exists(keys.raw)) { await redis.expire(keys.raw, decision.expireRawSeconds); rawExpired++; }
      if (await redis.exists(keys.results)) { await redis.expire(keys.results, decision.expireResultsSeconds); resultsExpired++; }
    }
  }
  console.log(JSON.stringify({ event:"redis_cleanup_batch", dryRun:DRY_RUN, scanned, rawDeleted, rawExpired, resultsExpired, missingJobs }));
}

console.log(JSON.stringify({ event:"redis_cleanup_complete", dryRun:DRY_RUN, scanned, rawDeleted, rawExpired, resultsExpired, missingJobs }));
await redis.quit();
```

- [ ] **Step 4: Add package scripts**

Add:

```json
"cleanup:acquisition-redis": "node recover-mcp/cleanup-acquisition-redis.mjs"
```

Preserve existing scripts unchanged.

- [ ] **Step 5: Run tests and syntax check**

```bash
node --test recover-mcp/acquisition-redis-cleanup.node-test.mjs
node --check recover-mcp/cleanup-acquisition-redis.mjs
```

Expected: PASS and no syntax errors.

- [ ] **Step 6: Commit**

```bash
git add recover-mcp/acquisition-redis-cleanup.mjs recover-mcp/acquisition-redis-cleanup.node-test.mjs recover-mcp/cleanup-acquisition-redis.mjs package.json
git commit -m "feat: add controlled Redis acquisition cleanup"
```

---

### Task 6: Full regression verification before deployment

**Files:**
- No new files expected.

**Interfaces:**
- Consumes: all changes from Tasks 1-5.
- Produces: verified branch safe to deploy.

- [ ] **Step 1: Run focused tests**

```bash
node --test \
  recover-mcp/acquisition-worker-lifecycle.node-test.mjs \
  recover-mcp/acquisition-redis-cleanup.node-test.mjs \
  recover-mcp/acquisition-worker-runtime.test.mjs \
  recover-mcp/acquisition-persistence.node-test.mjs \
  recover-mcp/acquisition-coverage.node-test.mjs \
  recover-mcp/home-service-targeting.test.mjs
```

Expected: all PASS.

- [ ] **Step 2: Run package test suite**

```bash
npm test
```

Expected: PASS. If an unrelated pre-existing test fails, capture the exact failure and do not hide it.

- [ ] **Step 3: Verify no dangerous Redis commands were introduced**

```bash
grep -RniE 'flushdb|flushall' recover-mcp package.json
```

Expected: no matches in executable cleanup/worker code.

- [ ] **Step 4: Verify only intended key families are mutable in cleanup CLI**

```bash
grep -nE 'del\(|expire\(' recover-mcp/cleanup-acquisition-redis.mjs
```

Expected: mutations only reference `keys.raw` and `keys.results`; no queue/controller/leadstore deletion.

- [ ] **Step 5: Commit any test-only correction if required**

Use a narrowly scoped commit message matching the correction.

---

### Task 7: Deploy lifecycle fix before cleanup

**Files:**
- Railway service: `acquisition-worker`
- Railway services: existing `acquisition-worker-g` through active shards as applicable.

**Interfaces:**
- Consumes: tested `recover-scrape-mcp` branch.
- Produces: workers that stop retaining completed raw payloads and apply short TTLs to active raw data.

- [ ] **Step 1: Confirm the GitHub commit is visible to Railway**

Check latest branch commit and Railway deployment list.

- [ ] **Step 2: Deploy/redeploy worker services**

Deploy the code change to the worker services that execute `npm run worker`. Do not scale the failed base worker to 12 replicas yet.

- [ ] **Step 3: Verify runtime logs**

Expected signals:

```text
Acquisition worker concurrency ...
Acquisition start ...
```

No source-patch exceptions, startup crashes, or Redis command errors.

- [ ] **Step 4: Verify new completed jobs remove raw payloads indirectly**

Use cleanup dry-run/audit output or a narrowly scoped Redis inspection endpoint/script to confirm terminal jobs no longer leave long-lived raw lists.

---

### Task 8: Reclaim existing Redis memory safely

**Files:**
- Runtime command only; no source changes expected.

**Interfaces:**
- Consumes: deployed cleanup CLI and production Redis.
- Produces: substantially reduced Redis memory without queue/controller/leadstore loss.

- [ ] **Step 1: Run cleanup in dry-run mode**

```bash
CLEANUP_DRY_RUN=1 CLEANUP_BATCH_SIZE=100 npm run cleanup:acquisition-redis
```

Expected: JSON summaries with scanned jobs and decisions, no memory mutation.

- [ ] **Step 2: Inspect dry-run totals**

Confirm terminal/failure counts are plausible and no active queue/controller data is targeted.

- [ ] **Step 3: Run real cleanup in small batches**

```bash
CLEANUP_DRY_RUN=0 CLEANUP_BATCH_SIZE=100 npm run cleanup:acquisition-redis
```

- [ ] **Step 4: Measure Railway Redis memory after cleanup**

Expected: significant decline from approximately 7.99 GB, with headroom below the 8 GB limit.

- [ ] **Step 5: Verify controller Redis errors stop**

Check `us-hvac-controller` logs. Expected: no continuous `ConnectionTimeoutError`, `ECONNREFUSED`, or `LOADING` loop.

- [ ] **Step 6: Verify queue/cursor health**

Confirm active queue begins draining toward configured high-water and controller cursor advances from its stalled value.

---

### Task 9: Restore worker capacity gradually

**Files:**
- Railway service scaling/configuration only.

**Interfaces:**
- Consumes: stable Redis and healthy worker code.
- Produces: increased throughput without recreating Redis/Maps instability.

- [ ] **Step 1: Confirm baseline stability for at least several controller cycles**

Check Redis memory trend, controller logs, Maps lane errors, and queue depth.

- [ ] **Step 2: Bring base worker back at low replica count**

Start with 1-2 replicas rather than 12.

- [ ] **Step 3: Observe queue and Redis after each scale step**

Do not increase further if Redis memory resumes rapid growth, Maps 502s spike, or controller errors return.

- [ ] **Step 4: Scale in small increments toward required capacity**

Increase only while queue depth falls and Redis remains comfortably below its limit.

- [ ] **Step 5: Verify new lead persistence in Supabase**

Confirm acquisition lead counts increase and recent records have expected no-website/contactable fields.

---

### Task 10: Post-fix production verification

**Files:**
- No source changes unless a verified defect is found.

**Interfaces:**
- Produces: final evidence that the incident is resolved.

- [ ] **Step 1: Capture Redis metrics**

Record current/average/max memory after cleanup and after worker scaling.

- [ ] **Step 2: Capture scraper throughput**

Compare completed acquisitions/stored leads over a fixed recent window with the degraded window.

- [ ] **Step 3: Confirm safety invariants**

Verify:

```text
Supabase leads preserved
active queue preserved
controller state preserved
coverage state preserved
qualified leadstore not flushed
completed raw payloads removed
```

- [ ] **Step 4: Document final production state**

Add a short incident/fix note if desired, including root cause, changes, Redis memory before/after, queue before/after, and worker replica state.
