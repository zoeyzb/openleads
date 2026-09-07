import { createClient } from "redis";
const redis=createClient({url:process.env.ACQUISITION_REDIS_URL||""});
await redis.connect();
const ids=await redis.sMembers("recover:acq:index");
let changed=0, queued=0, running=0, failed=0, complete=0, partial=0;
for(const id of ids){
  const key=`recover:acq:${id}`;
  const raw=await redis.get(key);
  if(!raw) continue;
  try{
    const j=JSON.parse(raw);
    if(j.status==="queued") queued++;
    else if(j.status==="running") running++;
    else if(j.status==="failed") failed++;
    else if(j.status==="complete") complete++;
    else if(j.status==="partial_complete") partial++;
    if(["queued","running"].includes(j.status)){
      j.status="cancelled"; j.phase="cancelled_by_user"; j.reason="user_requested_stop";
      j.updated_at=new Date().toISOString(); j.cancelled_at=j.updated_at;
      await redis.set(key,JSON.stringify(j),{EX:Number(process.env.ACQUISITION_TTL_SECONDS||604800)});
      changed++;
    }
  }catch{}
}
await redis.del("recover:acquisition:queue");
console.log(JSON.stringify({ok:true,total_ids:ids.length,changed,queued,running,failed,complete,partial_complete:partial,queue_cleared:true}));
await redis.quit();