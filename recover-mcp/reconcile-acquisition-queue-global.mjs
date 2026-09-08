import { createClient } from "redis";
const REDIS_URL=process.env.ACQUISITION_REDIS_URL||"";
if(!REDIS_URL) throw new Error("ACQUISITION_REDIS_URL required");
const redis=createClient({url:REDIS_URL});
await redis.connect();

const queueKey="recover:acquisition:queue";
const before=await redis.lRange(queueKey,0,-1);
const seen=new Set();
const keep=[];
let duplicates=0,missing=0,terminal=0,staleRunning=0,queued=0,running=0;

for(const id of before){
  if(seen.has(id)){duplicates++;continue;}
  seen.add(id);
  const raw=await redis.get("recover:acq:"+id);
  if(!raw){missing++;continue;}
  let job; try{job=JSON.parse(raw)}catch{missing++;continue;}
  if(["complete","partial_complete","failed","cancelled"].includes(job.status)){terminal++;continue;}
  if(job.status==="running"){
    const lease=await redis.get("recover:acq:"+id+":lease");
    if(!lease){
      job.status="queued";
      job.phase="requeued_by_queue_reconcile";
      job.updated_at=new Date().toISOString();
      await redis.set("recover:acq:"+id,JSON.stringify(job),{EX:Number(process.env.ACQUISITION_TTL_SECONDS||604800)});
      staleRunning++;
      keep.push(id);
      continue;
    }
    running++;
    continue;
  }
  if(job.status==="queued"){queued++;keep.push(id);continue;}
  keep.push(id);
}

const indexIds=await redis.sMembers("recover:acq:index");
for(const id of indexIds){
  if(seen.has(id)) continue;
  const raw=await redis.get("recover:acq:"+id); if(!raw) continue;
  let job; try{job=JSON.parse(raw)}catch{continue}
  if(job.status!=="queued") continue;
  keep.push(id); seen.add(id); queued++;
}

await redis.del(queueKey);
for(let i=keep.length-1;i>=0;i--) await redis.lPush(queueKey,keep[i]);

console.log(JSON.stringify({
  ok:true,before_len:before.length,after_len:await redis.lLen(queueKey),
  duplicates_removed:duplicates,missing_removed:missing,terminal_removed:terminal,
  stale_running_requeued:staleRunning,live_running_not_duplicated:running,
  queued_unique:queued
}));
await redis.quit();