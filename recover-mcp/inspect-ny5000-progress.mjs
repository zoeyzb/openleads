import { createClient } from "redis";
const redis=createClient({url:process.env.ACQUISITION_REDIS_URL||""});
await redis.connect();
const batchId=process.env.NY5000_BATCH_ID||"ny-hvac-no-website-5000-2026-09-07";
const ids=await redis.sMembers("recover:batch:"+batchId+":jobs");
const rows=[]; const counts={queued:0,running:0,complete:0,partial_complete:0,failed:0,cancelled:0,other:0};
let stored=0,qualified=0,raw=0,rounds=0;
for(const id of ids){
  const jraw=await redis.get("recover:acq:"+id); if(!jraw) continue;
  let j; try{j=JSON.parse(jraw)}catch{continue}
  const st=counts[j.status]!==undefined?j.status:"other"; counts[st]++;
  stored+=Number(j.stored_count||0); qualified+=Number(j.qualified_count||0); raw+=Number(j.raw_count||0); rounds+=Number(j.rounds_completed||0);
  rows.push({id,location:j.location,status:j.status,phase:j.phase,round:j.round,rounds_completed:j.rounds_completed||0,raw_count:j.raw_count||0,unique_count:j.unique_count||0,qualified_count:j.qualified_count||0,stored_count:j.stored_count||0,error:j.error||null,updated_at:j.updated_at});
}
rows.sort((a,b)=>String(b.updated_at||"").localeCompare(String(a.updated_at||"")));
const permanentCount=await redis.hLen("recover:leadstore:qualified");
const queueLen=await redis.lLen("recover:acquisition:queue");
console.log(JSON.stringify({ok:true,batch_id:batchId,total_jobs:rows.length,counts,queue_len:queueLen,totals:{stored,qualified,raw,rounds},permanent_count:permanentCount,active:rows.filter(r=>r.status==="running").slice(0,10),recent:rows.slice(0,15)}));
await redis.quit();