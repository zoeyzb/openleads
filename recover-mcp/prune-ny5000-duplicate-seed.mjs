import { createClient } from "redis";
const redis=createClient({url:process.env.ACQUISITION_REDIS_URL||""});
await redis.connect();
const batchId=process.env.NY5000_BATCH_ID||"ny-hvac-no-website-5000-2026-09-07";
const ids=await redis.sMembers("recover:batch:"+batchId+":jobs");
const jobs=[];
for(const id of ids){
  const raw=await redis.get("recover:acq:"+id);
  if(!raw) continue;
  try{ jobs.push(JSON.parse(raw)); }catch{}
}
const byLoc=new Map();
for(const j of jobs){
  const key=String(j.location||"").trim().toLowerCase();
  if(!byLoc.has(key)) byLoc.set(key,[]);
  byLoc.get(key).push(j);
}
const score=j=>[
  Number(j.stored_count||0),
  Number(j.qualified_count||0),
  Number(j.rounds_completed||0),
  -(Date.parse(j.created_at||0)||0)
];
const better=(a,b)=>{
  const sa=score(a), sb=score(b);
  for(let i=0;i<sa.length;i++){ if(sa[i]!==sb[i]) return sa[i]>sb[i]; }
  return false;
};
const keep=[], cancel=[];
for(const group of byLoc.values()){
  let best=group[0];
  for(const j of group.slice(1)) if(better(j,best)) best=j;
  keep.push(best);
  for(const j of group) if(j.id!==best.id) cancel.push(j);
}
const ttl=Number(process.env.ACQUISITION_TTL_SECONDS||604800);
const now=new Date().toISOString();
for(const j of cancel){
  j.status="cancelled";
  j.phase="cancelled_duplicate_seed";
  j.reason="duplicate_seeder_deployment";
  j.cancelled_at=now;
  j.updated_at=now;
  await redis.set("recover:acq:"+j.id,JSON.stringify(j),{EX:ttl});
  await redis.del("recover:acq:"+j.id+":lease");
  await redis.sRem("recover:batch:"+batchId+":jobs",j.id);
}
const keepIds=new Set(keep.map(j=>j.id));
for(const j of keep){
  if(["running","queued"].includes(j.status)){
    j.status="queued";
    j.phase="queued";
    j.updated_at=now;
    await redis.set("recover:acq:"+j.id,JSON.stringify(j),{EX:ttl});
  }
  await redis.del("recover:acq:"+j.id+":lease");
}
const existingQueue=await redis.lRange("recover:acquisition:queue",0,-1);
const batchAll=new Set(ids);
const nonBatch=existingQueue.filter(id=>!batchAll.has(id));
const pending=keep.filter(j=>j.status==="queued").map(j=>j.id);
await redis.del("recover:acquisition:queue");
for(const id of nonBatch.reverse()) await redis.lPush("recover:acquisition:queue",id);
for(const id of pending.reverse()) await redis.lPush("recover:acquisition:queue",id);
const metaRaw=await redis.get("recover:batch:"+batchId+":meta");
let meta={}; try{meta=JSON.parse(metaRaw||"{}")}catch{}
meta.area_count=keep.length;
meta.duplicate_jobs_removed=cancel.length;
meta.deduped_at=now;
meta.status="queued";
await redis.set("recover:batch:"+batchId+":meta",JSON.stringify(meta),{EX:ttl});
console.log(JSON.stringify({
  ok:true,batch_id:batchId,original_jobs:ids.length,unique_locations:keep.length,
  duplicate_jobs_removed:cancel.length,queued_jobs:pending.length,
  non_batch_queue_preserved:nonBatch.length
}));
await redis.quit();