import { createClient } from "redis";
const redis=createClient({url:process.env.ACQUISITION_REDIS_URL||""});
await redis.connect();
const ids=await redis.sMembers("recover:acq:index");
const rows=[];
for(const id of ids){
  const raw=await redis.get(`recover:acq:${id}`);
  if(!raw) continue;
  try{
    const j=JSON.parse(raw);
    rows.push({
      id,location:j.location,industry:j.industry,status:j.status,phase:j.phase,
      rounds_completed:j.rounds_completed||0,qualified_count:j.qualified_count||0,
      stored_count:j.stored_count||0,raw_count:j.raw_count||0,unique_count:j.unique_count||0,
      error:j.error||null,reason:j.reason||null,updated_at:j.updated_at,created_at:j.created_at,
      batch_id:j.batch_id||null
    });
  }catch{}
}
rows.sort((a,b)=>String(b.updated_at||"").localeCompare(String(a.updated_at||"")));
console.log(JSON.stringify({count:rows.length,rows:rows.slice(0,120)}));
await redis.quit();