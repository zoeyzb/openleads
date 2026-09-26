import { createClient } from "redis";
import { cleanupDecision, ephemeralKeysForJob } from "./acquisition-redis-cleanup.mjs";

const REDIS_URL = process.env.ACQUISITION_REDIS_URL || process.env.REDIS_URL || "";
if (!REDIS_URL) throw new Error("ACQUISITION_REDIS_URL required");

const RAW_TTL_SECONDS = Math.max(300, Number(process.env.ACQUISITION_RAW_TTL_SECONDS || 7200));
const RESULT_TTL_SECONDS = Math.max(3600, Number(process.env.ACQUISITION_RESULT_TTL_SECONDS || 86400));
const BATCH_SIZE = Math.min(500, Math.max(10, Number(process.env.CLEANUP_BATCH_SIZE || 100)));
const DRY_RUN = String(process.env.CLEANUP_DRY_RUN || "1") !== "0";

const redis = createClient({url:REDIS_URL});
redis.on("error", error => console.error("Redis error", error));
await redis.connect();

const ids = await redis.sMembers("recover:acq:index");
let scanned=0,rawDeleted=0,rawExpired=0,resultsExpired=0,missingJobs=0;

for (let offset=0; offset<ids.length; offset+=BATCH_SIZE) {
  const batch=ids.slice(offset,offset+BATCH_SIZE);
  for (const id of batch) {
    scanned++;
    const keys=ephemeralKeysForJob(id);
    const rawJob=await redis.get(keys.job);
    if (!rawJob) { missingJobs++; continue; }
    let job;
    try { job=JSON.parse(rawJob); } catch { continue; }
    const decision=cleanupDecision(job,{rawTtlSeconds:RAW_TTL_SECONDS,resultTtlSeconds:RESULT_TTL_SECONDS});
    if (!DRY_RUN) {
      if (decision.deleteRaw) rawDeleted += await redis.del(keys.raw);
      else if (await redis.exists(keys.raw)) { await redis.expire(keys.raw,decision.expireRawSeconds); rawExpired++; }
      if (await redis.exists(keys.results)) { await redis.expire(keys.results,decision.expireResultsSeconds); resultsExpired++; }
    }
  }
  console.log(JSON.stringify({event:"redis_cleanup_batch",dryRun:DRY_RUN,scanned,rawDeleted,rawExpired,resultsExpired,missingJobs}));
}
console.log(JSON.stringify({event:"redis_cleanup_complete",dryRun:DRY_RUN,scanned,rawDeleted,rawExpired,resultsExpired,missingJobs}));
await redis.quit();
