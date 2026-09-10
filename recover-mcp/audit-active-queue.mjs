import { createClient } from "redis";

const REDIS_URL=process.env.ACQUISITION_REDIS_URL||process.env.REDIS_URL||"";
if(!REDIS_URL) throw new Error("ACQUISITION_REDIS_URL required");

const redis=createClient({url:REDIS_URL});
redis.on("error",e=>console.error("Redis error",e));
await redis.connect();

const ACTIVE="recover:acquisition:queue";
const PAUSED_NATIONAL="recover:acquisition:queue:paused-national";
const PAUSED_NY="recover:acquisition:queue:paused-ny-surplus";
const PAUSED_LEGACY="recover:acquisition:queue:paused-legacy-national-v1";

const ids=await redis.lRange(ACTIVE,0,-1);
const now=Date.now();
const stats={
  total:ids.length,
  v2:0, legacy:0, missing:0,
  status:{},
  v2Status:{},
  legacyStatus:{},
  leased:0,
  legacyLeased:0,
  legacyNoLease:0,
  legacyStaleNoLease:0,
  legacyFreshNoLease:0,
  duplicates:ids.length-new Set(ids).size
};
const samples={legacyStaleNoLease:[],legacyLeased:[],v2:[]};

for(const id of ids){
  const raw=await redis.get("recover:acq:"+id);
  if(!raw){stats.missing++;continue;}
  let job; try{job=JSON.parse(raw)}catch{stats.missing++;continue;}
  const status=String(job.status||"unknown");
  const isV2=String(job.batch_id||"").startsWith("us-core-home-service-100k-v2") ||
    String(job.coverage_pass||"").startsWith("us-core-v2-");
  const lease=await redis.exists("recover:acq:"+id+":lease");
  const updated=Date.parse(job.updated_at||job.started_at||job.created_at||0);
  const ageMs=updated?Math.max(0,now-updated):Number.POSITIVE_INFINITY;
  const bucket=isV2?"v2Status":"legacyStatus";

  stats[isV2?"v2":"legacy"]++;
  stats.status[status]=(stats.status[status]||0)+1;
  stats[bucket][status]=(stats[bucket][status]||0)+1;
  if(lease) stats.leased++;

  if(isV2){
    if(samples.v2.length<10) samples.v2.push({id,status,location:job.location,age_s:Math.round(ageMs/1000),lease:!!lease});
  }else{
    if(lease){stats.legacyLeased++; if(samples.legacyLeased.length<15) samples.legacyLeased.push({id,status,location:job.location,age_s:Math.round(ageMs/1000)});}
    else{
      stats.legacyNoLease++;
      if(ageMs>180000){
        stats.legacyStaleNoLease++;
        if(samples.legacyStaleNoLease.length<30) samples.legacyStaleNoLease.push({
          id,status,phase:job.phase||"",location:job.location||"",age_s:Math.round(ageMs/1000),
          batch_id:job.batch_id||"",coverage_pass:job.coverage_pass||""
        });
      }else stats.legacyFreshNoLease++;
    }
  }
}

const queueLens={
  active:await redis.lLen(ACTIVE),
  pausedNational:await redis.lLen(PAUSED_NATIONAL),
  pausedNy:await redis.lLen(PAUSED_NY),
  pausedLegacy:await redis.lLen(PAUSED_LEGACY)
};

console.log(JSON.stringify({event:"active_queue_audit",stats,queueLens,samples},null,2));
await redis.quit();
