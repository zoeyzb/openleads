import { createClient } from "redis";
const redis=createClient({url:process.env.ACQUISITION_REDIS_URL||""});
await redis.connect();
const batchId=process.env.NY5000_BATCH_ID||"ny-hvac-no-website-5000-2026-09-07";
const ttl=Number(process.env.ACQUISITION_TTL_SECONDS||604800);
const ids=await redis.sMembers("recover:batch:"+batchId+":jobs");
const batchSet=new Set(ids);
const existingQueue=await redis.lRange("recover:acquisition:queue",0,-1);
const uniqueNonBatch=[];
const seenNonBatch=new Set();
for(const id of existingQueue){
  if(batchSet.has(id)) continue;
  if(seenNonBatch.has(id)) continue;
  seenNonBatch.add(id); uniqueNonBatch.push(id);
}
const enqueue=[];
const now=new Date().toISOString();
let orphanedRunning=0, liveRunning=0, queued=0, terminal=0;
for(const id of ids){
  const raw=await redis.get("recover:acq:"+id); if(!raw) continue;
  let j; try{j=JSON.parse(raw)}catch{continue}
  if(j.status==="running"){
    const lease=await redis.get("recover:acq:"+id+":lease");
    if(lease){ liveRunning++; continue; }
    j.status="queued";
    j.phase="requeued_orphaned_running";
    j.updated_at=now;
    await redis.set("recover:acq:"+id,JSON.stringify(j),{EX:ttl});
    orphanedRunning++;
    enqueue.push(id);
  } else if(j.status==="queued"){
    queued++;
    enqueue.push(id);
  } else {
    terminal++;
  }
}
const uniqBatch=[...new Set(enqueue)];
await redis.del("recover:acquisition:queue");
for(let i=uniqueNonBatch.length-1;i>=0;i--) await redis.lPush("recover:acquisition:queue",uniqueNonBatch[i]);
for(let i=uniqBatch.length-1;i>=0;i--) await redis.lPush("recover:acquisition:queue",uniqBatch[i]);
console.log(JSON.stringify({
  ok:true,batch_id:batchId,
  before_queue_len:existingQueue.length,
  after_queue_len:await redis.lLen("recover:acquisition:queue"),
  batch_queue_unique:uniqBatch.length,
  orphaned_running_requeued:orphanedRunning,
  live_running_preserved:liveRunning,
  queued_jobs:queued,
  terminal_jobs:terminal,
  non_batch_preserved:uniqueNonBatch.length
}));
await redis.quit();