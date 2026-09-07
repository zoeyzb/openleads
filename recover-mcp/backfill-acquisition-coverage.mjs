import { createClient } from "redis";
import { coverageField, readCoverage, markCoverage } from "./acquisition-coverage.mjs";

const redis=createClient({url:process.env.ACQUISITION_REDIS_URL||""});
if(!process.env.ACQUISITION_REDIS_URL) throw new Error("ACQUISITION_REDIS_URL required");
await redis.connect();
const ids=await redis.sMembers("recover:acq:index");
let scanned=0,written=0,kept=0;
const statuses={};
for(const id of ids){
  const raw=await redis.get("recover:acq:"+id); if(!raw) continue;
  let job; try{job=JSON.parse(raw)}catch{continue}
  scanned++;
  let status;
  if(job.status==="complete") status="target_reached";
  else if(job.status==="partial_complete") status="exhausted";
  else if(job.status==="running") status="running";
  else if(job.status==="queued") status="scheduled";
  else continue;
  const existing=await readCoverage(redis,job);
  if(existing && ["target_reached","exhausted"].includes(existing.status)){kept++; continue;}
  await markCoverage(redis,job,status,{backfilled:true,source_status:job.status});
  written++; statuses[status]=(statuses[status]||0)+1;
}
console.log(JSON.stringify({ok:true,scanned,written,kept,statuses,coverage_count:await redis.hLen("recover:coverage:v1")}));
await redis.quit();
