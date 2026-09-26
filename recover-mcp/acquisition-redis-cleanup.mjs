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

export function ephemeralKeysForJob(id) {
  const safeId = String(id || "").trim();
  if (!safeId) throw new Error("job id required");
  return {
    job:`recover:acq:${safeId}`,
    raw:`recover:acq:${safeId}:raw`,
    results:`recover:acq:${safeId}:results`
  };
}
