import { createClient } from "redis";
const REDIS_URL=process.env.ACQUISITION_REDIS_URL||"";
if(!REDIS_URL) throw new Error("ACQUISITION_REDIS_URL required");
const redis=createClient({url:REDIS_URL});
await redis.connect();
const batchId=process.env.NY_BATCH_ID||"ny-hvac-contactable-2026-09-07";
const ids=await redis.sMembers(`recover:batch:${batchId}:jobs`);
const summary={queued:0,running:0,complete:0,partial_complete:0,failed:0,other:0,stored:0,qualified:0};
for(const id of ids){
  const key=`recover:acq:${id}`;
  const raw=await redis.get(key);
  if(!raw) continue;
  const job=JSON.parse(raw);
  summary[job.status] = (summary[job.status]??0)+1;
  summary.stored += Number(job.stored_count||0);
  summary.qualified += Number(job.qualified_count||0);
  if(["queued","running"].includes(job.status)){
    job.status="cancelled";
    job.phase="cancelled_by_user";
    job.reason="user_requested_stop";
    job.updated_at=new Date().toISOString();
    job.cancelled_at=job.updated_at;
    await redis.set(key,JSON.stringify(job),{EX:Number(process.env.ACQUISITION_TTL_SECONDS||604800)});
  }
}
await redis.del("recover:acquisition:queue");
console.log(JSON.stringify({ok:true,batch_id:batchId,jobs:ids.length,before:summary,queue_cleared:true}));
await redis.quit();