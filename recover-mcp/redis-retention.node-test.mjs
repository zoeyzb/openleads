import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVE_RAW_TTL_SECONDS,
  FAILED_RAW_GRACE_SECONDS,
  rawRetentionAction
} from "./redis-retention.mjs";

const NOW = Date.parse("2026-09-16T00:00:00.000Z");

test("deletes raw payload immediately for completed acquisitions", () => {
  assert.deepEqual(rawRetentionAction({ status: "complete" }, NOW), {
    action: "delete",
    reason: "terminal_complete"
  });
  assert.deepEqual(rawRetentionAction({ status: "partial_complete" }, NOW), {
    action: "delete",
    reason: "terminal_partial_complete"
  });
});

test("keeps active raw payloads briefly instead of seven days", () => {
  assert.deepEqual(rawRetentionAction({ status: "running" }, NOW), {
    action: "expire",
    ttlSeconds: ACTIVE_RAW_TTL_SECONDS,
    reason: "active_running"
  });
});

test("gives recent failed jobs a one-hour debugging grace period", () => {
  const updatedAt = new Date(NOW - 10 * 60 * 1000).toISOString();
  assert.deepEqual(rawRetentionAction({ status: "failed", updated_at: updatedAt }, NOW), {
    action: "expire",
    ttlSeconds: FAILED_RAW_GRACE_SECONDS,
    reason: "grace_failed"
  });
});

test("deletes failed raw payloads after the debugging grace period", () => {
  const updatedAt = new Date(NOW - 2 * 60 * 60 * 1000).toISOString();
  assert.deepEqual(rawRetentionAction({ status: "failed", updated_at: updatedAt }, NOW), {
    action: "delete",
    reason: "stale_failed"
  });
});

test("deletes orphan raw payloads whose acquisition job is gone", () => {
  assert.deepEqual(rawRetentionAction(null, NOW), {
    action: "delete",
    reason: "missing_job"
  });
});
