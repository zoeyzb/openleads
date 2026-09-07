import { createClient } from "redis";
import { randomUUID } from "node:crypto";

const REDIS_URL = process.env.ACQUISITION_REDIS_URL || "";
const JOB_TTL = Number(process.env.ACQUISITION_TTL_SECONDS || 604800);
if (!REDIS_URL) throw new Error("ACQUISITION_REDIS_URL is required");

const areas = [
  "Brooklyn, NY","Bronx, NY","Staten Island, NY","Yonkers, NY","New Rochelle, NY",
  "White Plains, NY","Mount Vernon, NY","Peekskill, NY","Poughkeepsie, NY","Newburgh, NY",
  "Middletown, NY","Kingston, NY","Albany, NY","Troy, NY","Schenectady, NY",
  "Saratoga Springs, NY","Glens Falls, NY","Syracuse, NY","Utica, NY","Rome, NY",
  "Rochester, NY","Buffalo, NY","Niagara Falls, NY","Binghamton, NY","Elmira, NY",
  "Ithaca, NY","Watertown, NY","Plattsburgh, NY","Jamestown, NY","Olean, NY",
  "Auburn, NY","Oswego, NY","Cortland, NY","Oneonta, NY","Amsterdam, NY",
  "Batavia, NY","Canandaigua, NY","Geneva, NY","Lockport, NY","North Tonawanda, NY"
];

const targetPerArea = Number(process.env.NY_TARGET_PER_AREA || 170);
const batchId = process.env.NY_BATCH_ID || `ny-hvac-contactable-${new Date().toISOString().replace(/[:.]/g,"-")}`;
const redis = createClient({ url: REDIS_URL });
await redis.connect();

const jobs = [];
for (const location of areas) {
  const id = randomUUID();
  const now = new Date().toISOString();
  const job = {
    id,
    batch_id: batchId,
    industry: "HVAC",
    location,
    target: targetPerArea,
    min_score: 30,
    require_phone: false,
    require_email: false,
    require_contact: true,
    include_no_website: true,
    max_rounds: 20,
    depth: 25,
    status: "queued",
    phase: "queued",
    round: 0,
    rounds_completed: 0,
    raw_count: 0,
    unique_count: 0,
    qualified_count: 0,
    stored_count: 0,
    maps_jobs: [],
    created_at: now,
    updated_at: now
  };
  await redis.set(`recover:acq:${id}`, JSON.stringify(job), { EX: JOB_TTL });
  await redis.sAdd("recover:acq:index", id);
  await redis.sAdd(`recover:batch:${batchId}:jobs`, id);
  await redis.expire(`recover:batch:${batchId}:jobs`, JOB_TTL);
  await redis.lPush("recover:acquisition:queue", id);
  jobs.push({ id, location, target: targetPerArea });
}

await redis.set(`recover:batch:${batchId}:meta`, JSON.stringify({
  batch_id: batchId,
  industry: "HVAC",
  region: "New York",
  requirement: "phone_or_email",
  requested_total: areas.length * targetPerArea,
  area_count: areas.length,
  status: "queued",
  created_at: new Date().toISOString()
}), { EX: JOB_TTL });

console.log(JSON.stringify({
  ok: true,
  batch_id: batchId,
  area_count: areas.length,
  target_per_area: targetPerArea,
  requested_total: areas.length * targetPerArea,
  jobs
}));
await redis.quit();
