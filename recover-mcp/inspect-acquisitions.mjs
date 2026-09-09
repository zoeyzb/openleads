import { createClient } from "redis";

const redis=createClient({url:process.env.ACQUISITION_REDIS_URL||""});
await redis.connect();

const ACTIVE_QUEUE="recover:acquisition:queue";
const PRIORITY_QUEUE="recover:acquisition:queue:ny-priority";
const PAUSED_QUEUE="recover:acquisition:queue:paused-national";

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

async function inspectQueue(key){
  const q=await redis.lRange(key,0,-1);
  const unique=[...new Set(q.map(String))];
  const batchCounts={}, statusCounts={};
  let ny=0, nonNy=0, missing=0;
  const sample=[];
  for(const id of unique){
    const raw=await redis.get(`recover:acq:${id}`);
    if(!raw){ missing++; continue; }
    try{
      const j=JSON.parse(raw);
      const location=String(j.location||"");
      if(/\bNY\b|New York/i.test(location)) ny++; else nonNy++;
      const batch=String(j.batch_id||"(none)");
      const status=String(j.status||"(none)");
      batchCounts[batch]=(batchCounts[batch]||0)+1;
      statusCounts[status]=(statusCounts[status]||0)+1;
      if(sample.length<30) sample.push({id,location,batch_id:j.batch_id||null,status:j.status||null,phase:j.phase||null});
    }catch{ missing++; }
  }
  return {
    key,
    length:q.length,
    unique:unique.length,
    duplicates:q.length-unique.length,
    ny,
    non_ny:nonNy,
    missing,
    batch_counts:batchCounts,
    status_counts:statusCounts,
    sample
  };
}

const [active,priority,paused]=await Promise.all([
  inspectQueue(ACTIVE_QUEUE),
  inspectQueue(PRIORITY_QUEUE),
  inspectQueue(PAUSED_QUEUE)
]);

console.log(JSON.stringify({
  count:rows.length,
  queues:{active,priority,paused},
  recent:rows.slice(0,40)
}));
await redis.quit();

// Trigger post-restart queue audit 2026-09-09T08:40Z
