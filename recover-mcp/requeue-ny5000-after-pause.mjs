import { createClient } from "redis";
const redis=createClient({url:process.env.ACQUISITION_REDIS_URL||""});
await redis.connect();
const batchId=process.env.NY5000_BATCH_ID||"ny-hvac-no-website-5000-2026-09-07";
const ttl=Number(process.env.ACQUISITION_TTL_SECONDS||604800);
const ids=await redis.sMembers("recover:batch:"+batchId+":jobs");
const batchSet=new Set(ids);
const now=new Date().toISOString();
const queue=await redis.lRange("recover:acquisition:queue",0,-1);
const keepNonBatch=[...new Set(queue.filter(id=>!batchSet.has(id)))];
const pending=[];
let requeuedRunning=0,queued=0,terminal=0;
for(const id of ids){
  const raw=await redis.get("recover:acq:"+id); if(!raw) continue;
  let j; try{j=JSON.parse(raw)}catch{continue}
  if(j.status==="running"){
    j.status="queued"; j.phase="requeued_after_controlled_pause"; j.updated_at=now;
    await redis.set("recover:acq:"+id,JSON.stringify(j),{EX:ttl});
    await redis.del("recover:acq:"+id+":lease");
    requeuedRunning++; pending.push(id);
  } else if(j.status==="queued"){
    await redis.del("recover:acq:"+id+":lease");
    queued++; pending.push(id);
  } else terminal++;
}
const uniq=[...new Set(pending)];
await redis.del("recover:acquisition:queue");
for(let i=keepNonBatch.length-1;i>=0;i--) await redis.lPush("recover:acquisition:queue",keepNonBatch[i]);
for(let i=uniq.length-1;i>=0;i--) await redis.lPush("recover:acquisition:queue",uniq[i]);
console.log(JSON.stringify({ok:true,batch_id:batchId,requeued_running:requeuedRunning,already_queued:queued,terminal,batch_queue_unique:uniq.length,queue_len:await redis.lLen("recover:acquisition:queue")}));
await redis.quit();