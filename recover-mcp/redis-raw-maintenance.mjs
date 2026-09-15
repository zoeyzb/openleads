import { createClient } from "redis";
import { rawRetentionAction } from "./redis-retention.mjs";

const REDIS_URL = process.env.ACQUISITION_REDIS_URL || process.env.REDIS_URL || "";
const SCAN_COUNT = Number(process.env.REDIS_RAW_MAINTENANCE_SCAN_COUNT || 200);
const DRY_RUN = /^(1|true|yes)$/i.test(String(process.env.REDIS_RAW_MAINTENANCE_DRY_RUN || ""));
const RAW_PATTERN = "recover:acq:*:raw";

if (!REDIS_URL) throw new Error("ACQUISITION_REDIS_URL is required");

const redis = createClient({ url: REDIS_URL });
redis.on("error", error => console.error("Redis error", error));
await redis.connect();

const totals = {
  dry_run: DRY_RUN,
  scanned: 0,
  deleted: 0,
  expired: 0,
  parse_errors: 0,
  batches: 0,
  reasons: {}
};

function note(reason) {
  totals.reasons[reason] = (totals.reasons[reason] || 0) + 1;
}

try {
  for await (const yielded of redis.scanIterator({ MATCH: RAW_PATTERN, COUNT: SCAN_COUNT })) {
    const rawKeys = Array.isArray(yielded) ? yielded : [yielded];
    if (!rawKeys.length) continue;

    totals.batches += 1;
    totals.scanned += rawKeys.length;

    const jobKeys = rawKeys.map(key => String(key).replace(/:raw$/, ""));
    const jobValues = await redis.mGet(jobKeys);
    const tx = DRY_RUN ? null : redis.multi();

    for (let i = 0; i < rawKeys.length; i++) {
      const rawKey = rawKeys[i];
      const value = jobValues[i];
      let job = null;

      if (value) {
        try {
          job = JSON.parse(value);
        } catch {
          totals.parse_errors += 1;
        }
      }

      const decision = rawRetentionAction(job);
      note(decision.reason);

      if (decision.action === "delete") {
        if (!DRY_RUN) tx.del(rawKey);
        totals.deleted += 1;
      } else {
        if (!DRY_RUN) tx.expire(rawKey, decision.ttlSeconds);
        totals.expired += 1;
      }
    }

    if (!DRY_RUN) await tx.exec();

    if (totals.batches % 10 === 0) {
      console.log(JSON.stringify({ event: "redis_raw_maintenance_progress", ...totals }));
    }
  }

  console.log(JSON.stringify({ event: "redis_raw_maintenance_complete", ...totals }));
} finally {
  await redis.quit().catch(() => {});
}
