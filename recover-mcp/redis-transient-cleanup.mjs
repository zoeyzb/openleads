import { createClient } from "redis";

const REDIS_URL=process.env.ACQUISITION_REDIS_URL||process.env.REDIS_URL||"";
if(!REDIS_URL) throw new Error("ACQUISITION_REDIS_URL or REDIS_URL required");
const APPLY=String(process.env.APPLY_REDIS_CLEANUP||"false").toLowerCase()==="true";
const RAW_KEEP_MS=Math.max(30*60*1000,Number(process.env.REDIS_RAW_KEEP_MS||2*60*60*1000));
const RESULTS_KEEP_MS=Math.max(2*60*60*1000,Number(process.env.REDIS_RESULTS_KEEP_MS||24*60*60*1000));
const TERMINAL=new Set(["complete","partial_complete","failed","error","parked"]);

const redis=createClient({url:REDIS_URL});
redis.on("error",e=>console.error("redis_error",String(e?.message||e)));
await redis.connect();

async function scanKeys(pattern){
  const keys=[]; let cursor="0";
  do{
    const page=await redis.scan(cursor,{MATCH:pattern,COUNT:1000});
    cursor=String(page.cursor);
    keys.push(...(page.keys||[]));
  }while(cursor!=="0");
  return keys;
}
function jobIdFromKey(key,suffix){
  return key.slice("recover:acq:".length,-suffix.length);
}
function ageMs(job){
  const t=Date.parse(job?.updated_at||job?.completed_at||job?.created_at||0);
  return t?Math.max(0,Date.now()-t):Number.POSITIVE_INFINITY;
}

async function classify(keys,suffix,keepMs){
  let reclaimBytes=0,keepBytes=0,missingJobBytes=0;
  let reclaimKeys=0,keepKeys=0,missingJobs=0;
  const deleteKeys=[],expireKeys=[];
  for(let i=0;i<keys.length;i+=100){
    const chunk=keys.slice(i,i+100);
    const jobKeys=chunk.map(k=>"recover:acq:"+jobIdFromKey(k,suffix));
    const multi=redis.multi();
    for(const k of chunk) multi.memoryUsage(k);
    for(const jk of jobKeys) multi.get(jk);
    for(const k of chunk) multi.ttl(k);
    const values=await multi.exec();
    const n=chunk.length;
    for(let j=0;j<n;j++){
      const key=chunk[j], bytes=Number(values?.[j]||0);
      const rawJob=values?.[n+j];
      const ttl=Number(values?.[2*n+j]??-2);
      let job=null;
      if(rawJob){try{job=JSON.parse(rawJob)}catch{}}
      if(!job){
        // Orphaned transient payloads have no acquisition metadata and cannot
        // contribute new qualified leads. They are safe to reclaim.
        reclaimBytes+=bytes; reclaimKeys++; missingJobBytes+=bytes; missingJobs++;
        deleteKeys.push(key);
        continue;
      }
      const terminal=TERMINAL.has(String(job.status||""));
      const old=ageMs(job)>=keepMs;
      if(terminal&&old){
        reclaimBytes+=bytes; reclaimKeys++; deleteKeys.push(key);
      }else{
        keepBytes+=bytes; keepKeys++;
        if(ttl<0 || ttl>Math.ceil(keepMs/1000)) expireKeys.push(key);
      }
    }
  }
  return {reclaimBytes,keepBytes,reclaimKeys,keepKeys,missingJobBytes,missingJobs,deleteKeys,expireKeys};
}

async function applyChanges(plan,ttlSeconds){
  let deleted=0,expired=0;
  for(let i=0;i<plan.deleteKeys.length;i+=500){
    const chunk=plan.deleteKeys.slice(i,i+500);
    if(chunk.length){deleted+=await redis.unlink(chunk);}
  }
  for(let i=0;i<plan.expireKeys.length;i+=500){
    const chunk=plan.expireKeys.slice(i,i+500);
    const multi=redis.multi();
    for(const key of chunk) multi.expire(key,ttlSeconds);
    const res=await multi.exec();
    expired+=res.filter(Boolean).length;
  }
  return {deleted,expired};
}

const rawKeys=await scanKeys("recover:acq:*:raw");
const resultKeys=await scanKeys("recover:acq:*:results");
const rawPlan=await classify(rawKeys,":raw",RAW_KEEP_MS);
const resultsPlan=await classify(resultKeys,":results",RESULTS_KEEP_MS);

console.log(JSON.stringify({
  event:"redis_transient_cleanup_plan",apply:APPLY,
  raw:{keys:rawKeys.length,reclaimKeys:rawPlan.reclaimKeys,keepKeys:rawPlan.keepKeys,reclaimMB:Number((rawPlan.reclaimBytes/1024/1024).toFixed(2)),keepMB:Number((rawPlan.keepBytes/1024/1024).toFixed(2)),orphanKeys:rawPlan.missingJobs},
  results:{keys:resultKeys.length,reclaimKeys:resultsPlan.reclaimKeys,keepKeys:resultsPlan.keepKeys,reclaimMB:Number((resultsPlan.reclaimBytes/1024/1024).toFixed(2)),keepMB:Number((resultsPlan.keepBytes/1024/1024).toFixed(2)),orphanKeys:resultsPlan.missingJobs}
}));

if(APPLY){
  const rawApplied=await applyChanges(rawPlan,Math.ceil(RAW_KEEP_MS/1000));
  const resultsApplied=await applyChanges(resultsPlan,Math.ceil(RESULTS_KEEP_MS/1000));
  console.log(JSON.stringify({event:"redis_transient_cleanup_applied",raw:rawApplied,results:resultsApplied}));
}

await redis.quit();
