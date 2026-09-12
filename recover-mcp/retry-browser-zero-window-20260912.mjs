import { createClient } from 'redis';

const REDIS_URL=process.env.ACQUISITION_REDIS_URL||process.env.REDIS_URL||'';
if(!REDIS_URL) throw new Error('ACQUISITION_REDIS_URL required');

const redis=createClient({url:REDIS_URL});
redis.on('error',e=>console.error('Redis error',e));
await redis.connect();

const START=Date.parse('2026-09-12T12:25:00Z');
const END=Date.parse('2026-09-12T12:39:33Z');
const REPAIR_KEY='recover:repair:maps-libglib-zero-window:2026-09-12:v1';
const ACTIVE_QUEUE='recover:acquisition:queue';
const CITY_PRIORITY_QUEUE='recover:acquisition:queue:us-city-priority';
const TTL=Number(process.env.ACQUISITION_TTL_SECONDS||604800);

const already=await redis.get(REPAIR_KEY);
if(already){
  console.log(JSON.stringify({event:'browser_zero_retry_skipped',reason:'already_applied',value:already}));
  await redis.quit();
  process.exit(0);
}

const ids=await redis.sMembers('recover:acq:index');
let inspected=0, matched=0, requeued=0;
const byStatus={};
const sample=[];
const now=new Date().toISOString();

for(const id of ids){
  const raw=await redis.get(`recover:acq:${id}`);
  if(!raw) continue;
  let job;
  try{ job=JSON.parse(raw); }catch{ continue; }
  inspected++;
  if(String(job.search_profile||'')!=='core-home-service') continue;
  const ts=Date.parse(job.updated_at||job.completed_at||job.created_at||'');
  if(!Number.isFinite(ts)||ts<START||ts>END) continue;
  if(Number(job.raw_count||0)!==0||Number(job.stored_count||0)!==0||Number(job.qualified_count||0)!==0) continue;
  const status=String(job.status||'').toLowerCase();
  if(['queued','running'].includes(status)) continue;

  matched++;
  byStatus[status||'(none)']=(byStatus[status||'(none)']||0)+1;
  const queue=String(job.scheduler_mode||'')==='coverage'?CITY_PRIORITY_QUEUE:ACTIVE_QUEUE;

  const retried={
    ...job,
    status:'queued',
    phase:'queued',
    round:0,
    rounds_completed:0,
    raw_count:0,
    unique_count:0,
    qualified_count:0,
    stored_count:0,
    maps_jobs:[],
    error:null,
    reason:'retry_after_maps_libglib_runtime_failure_2026-09-12',
    browser_runtime_retry:true,
    browser_runtime_retry_at:now,
    updated_at:now
  };

  await redis.lRem(ACTIVE_QUEUE,0,id);
  await redis.lRem(CITY_PRIORITY_QUEUE,0,id);
  await redis.set(`recover:acq:${id}`,JSON.stringify(retried),{EX:TTL});
  await redis.lPush(queue,id);
  requeued++;
  if(sample.length<25) sample.push({id,location:job.location,service_family:job.service_family,status_before:status,queue});
}

await redis.set(REPAIR_KEY,JSON.stringify({applied_at:now,inspected,matched,requeued,byStatus}),{EX:TTL});
console.log(JSON.stringify({event:'browser_zero_retry_applied',window:{start:new Date(START).toISOString(),end:new Date(END).toISOString()},inspected,matched,requeued,byStatus,sample}));
await redis.quit();
