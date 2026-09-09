import { createClient } from "redis";

const REDIS_URL=process.env.ACQUISITION_REDIS_URL||"";
if(!REDIS_URL) throw new Error("ACQUISITION_REDIS_URL required");

const ACTIVE="recover:acquisition:queue";
const PRIORITY="recover:acquisition:queue:ny-priority";
const PAUSED="recover:acquisition:queue:paused-national";

const redis=createClient({url:REDIS_URL});
redis.on("error",e=>console.error("Redis error",e));
await redis.connect();

const [active,priority,paused]=await Promise.all([
  redis.lRange(ACTIVE,0,-1),
  redis.lRange(PRIORITY,0,-1),
  redis.lRange(PAUSED,0,-1)
]);

const seen=new Set();
const ordered=[];
for(const id of [...priority,...active,...paused]){
  const s=String(id);
  if(!seen.has(s)){ seen.add(s); ordered.push(s); }
}

const nyQueued=[];
const nationalQueued=[];
const running=[];
const other=[];
const missing=[];

for(const id of ordered){
  const raw=await redis.get("recover:acq:"+id);
  if(!raw){ missing.push(id); continue; }
  let job;
  try{ job=JSON.parse(raw); }catch{ missing.push(id); continue; }

  const status=String(job.status||"");
  const isNy=/\bNY\b|New York/i.test(String(job.location||""));

  if(status==="running"){
    running.push(id);
    continue;
  }
  if(status==="queued"){
    if(isNy) nyQueued.push(id);
    else nationalQueued.push(id);
    continue;
  }
  other.push({id,status,location:job.location||""});
}

const multi=redis.multi();
multi.del(ACTIVE);
multi.del(PRIORITY);
multi.del(PAUSED);

if(nyQueued.length) multi.rPush(PRIORITY,nyQueued);
if(nationalQueued.length) multi.rPush(PAUSED,nationalQueued);

await multi.exec();

const [activeAfter,priorityAfter,pausedAfter]=await Promise.all([
  redis.lLen(ACTIVE),
  redis.lLen(PRIORITY),
  redis.lLen(PAUSED)
]);

console.log(JSON.stringify({
  ok:true,
  before:{
    active_length:active.length,
    priority_length:priority.length,
    paused_length:paused.length,
    total_entries:active.length+priority.length+paused.length,
    unique_ids:ordered.length
  },
  normalized:{
    ny_queued:nyQueued.length,
    national_queued:nationalQueued.length,
    running_excluded:running.length,
    nonqueued_excluded:other.length,
    missing_excluded:missing.length
  },
  after:{
    active_length:activeAfter,
    priority_length:priorityAfter,
    paused_length:pausedAfter
  },
  safety:{
    jobs_deleted:false,
    acquisition_records_untouched:true,
    only_queue_lists_rebuilt:true
  }
}));

await redis.quit();
