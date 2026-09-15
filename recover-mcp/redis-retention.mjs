export const ACTIVE_RAW_TTL_SECONDS = 2 * 60 * 60;
export const FAILED_RAW_GRACE_SECONDS = 60 * 60;

const IMMEDIATE_TERMINAL = new Set([
  "complete",
  "partial_complete"
]);

const FAILED_TERMINAL = new Set([
  "failed",
  "cancelled",
  "canceled"
]);

export function rawRetentionAction(job, nowMs = Date.now()) {
  if (!job || typeof job !== "object") return { action: "delete", reason: "missing_job" };

  const status = String(job.status || "").trim().toLowerCase();
  if (IMMEDIATE_TERMINAL.has(status)) {
    return { action: "delete", reason: `terminal_${status}` };
  }

  if (FAILED_TERMINAL.has(status)) {
    const updatedMs = Date.parse(job.updated_at || job.completed_at || job.started_at || job.created_at || "");
    const ageSeconds = Number.isFinite(updatedMs)
      ? Math.max(0, Math.floor((nowMs - updatedMs) / 1000))
      : Number.POSITIVE_INFINITY;

    if (ageSeconds >= FAILED_RAW_GRACE_SECONDS) {
      return { action: "delete", reason: `stale_${status}` };
    }

    return {
      action: "expire",
      ttlSeconds: FAILED_RAW_GRACE_SECONDS,
      reason: `grace_${status}`
    };
  }

  return {
    action: "expire",
    ttlSeconds: ACTIVE_RAW_TTL_SECONDS,
    reason: status ? `active_${status}` : "active_unknown"
  };
}
