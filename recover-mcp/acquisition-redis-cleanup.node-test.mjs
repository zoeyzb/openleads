import test from "node:test";
import assert from "node:assert/strict";
import { cleanupDecision, ephemeralKeysForJob } from "./acquisition-redis-cleanup.mjs";

const NOW = Date.parse("2026-09-16T00:00:00Z");
const job = (status, updated_at) => ({status, updated_at});

test("terminal success deletes raw and briefly retains compact results", () => {
  assert.deepEqual(
    cleanupDecision(job("complete","2026-09-15T23:59:00Z"), {nowMs:NOW, rawTtlSeconds:7200, resultTtlSeconds:86400}),
    {deleteRaw:true, expireRawSeconds:null, expireResultsSeconds:86400, reason:"terminal_success"}
  );
  assert.equal(cleanupDecision(job("partial_complete","2026-09-15T23:59:00Z"), {nowMs:NOW}).deleteRaw, true);
});

test("active jobs keep raw with short TTL", () => {
  assert.deepEqual(
    cleanupDecision(job("queued","2026-09-15T23:30:00Z"), {nowMs:NOW, rawTtlSeconds:7200, resultTtlSeconds:86400}),
    {deleteRaw:false, expireRawSeconds:7200, expireResultsSeconds:86400, reason:"active_or_retryable"}
  );
});

test("old failed jobs delete raw while fresh failures retain it for debugging", () => {
  assert.equal(cleanupDecision(job("failed","2026-09-15T20:00:00Z"), {nowMs:NOW, rawTtlSeconds:7200}).deleteRaw, true);
  assert.equal(cleanupDecision(job("failed","2026-09-15T23:30:00Z"), {nowMs:NOW, rawTtlSeconds:7200}).deleteRaw, false);
});

test("cleanup key helper cannot target queue/controller/leadstore keys", () => {
  const keys=ephemeralKeysForJob("abc");
  assert.deepEqual(keys,{job:"recover:acq:abc",raw:"recover:acq:abc:raw",results:"recover:acq:abc:results"});
  assert.doesNotMatch(JSON.stringify(keys),/queue|controller|leadstore/);
});
