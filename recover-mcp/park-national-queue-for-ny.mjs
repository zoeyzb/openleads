import { createClient } from "redis";

const REDIS_URL=process.env.ACQUISITION_REDIS_URL||"";
if(!REDIS_URL) throw new Error("ACQUISITION_REDIS_URL required");
const redis=createClient({url:REDIS_URL});
await redis.connect();

const source="recover:acquisition:queue";
const parked="recover:acquisition:queue:paused-national";
const priority="recover:acquisition:queue:ny-priority";
const ids=await redis.lRange(source,0,-1);
const keep=[]; const park=[]; const seen=new Set();

const isNy=(job)=>/\bny\b|new york/i.test(String(job?.location||""));
for(const id of ids){
  if(seen.has(id)) continue;
  seen.add(id);
  const raw=await redis.get("recover:acq:"+id);
  if(!raw) continue;
  let job; try{job=JSON.parse(raw)}catch{continue}
  if(job.status!=="queued") continue;
  if(isNy(job)) keep.push(id);
  else park.push(id);
}

await redis.del(source);
for(let i=keep.length-1;i>=0;i--) await redis.lPush(source,keep[i]);
if(park.length) {
  for(let i=park.length-1;i>=0;i--) {
    const id=park[i];
    const pos=await redis.lPos(parked,id);
    if(pos===null) await redis.lPush(parked,id);
  }
}
console.log(JSON.stringify({
  ok:true,
  source_before:ids.length,
  ny_kept:keep.length,
  national_parked:park.length,
  source_after:await redis.lLen(source),
  priority_len:await redis.lLen(priority),
  parked_len:await redis.lLen(parked)
}));
await redis.quit();
