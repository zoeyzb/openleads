import { createClient } from "redis";

const url=process.env.ACQUISITION_REDIS_URL||process.env.REDIS_URL||"";
if(!url) throw new Error("ACQUISITION_REDIS_URL required");
const redis=createClient({url,socket:{connectTimeout:10000,keepAlive:5000}});
redis.on("error",e=>console.error("cleanup redis error",String(e?.message||e)));
await redis.connect();

const INDEX="recover:acq:index";
const LEAD_HASH="recover:leadstore:qualified";
const PENDING_SET="recover:law-firm:enrich-pending:v2";
const ids=await redis.sMembers(INDEX);
let lawJobs=0,oldJobs=0,deletedJobKeys=0;

for(let i=0;i<ids.length;i+=250){
  const chunk=ids.slice(i,i+250);
  const raws=await redis.mGet(chunk.map(id=>`recover:acq:${id}`));
  const remove=[];
  const multi=redis.multi();
  for(let j=0;j<chunk.length;j++){
    const id=chunk[j];
    let job=null;
    try{job=raws[j]?JSON.parse(raws[j]):null;}catch{}
    const isLaw=String(job?.search_profile||"")==="law-firm" ||
      String(job?.industry||"").toUpperCase()==="LAW_FIRM" ||
      String(job?.batch_id||"").startsWith("us-law-firm-");
    if(isLaw){lawJobs++;continue;}
    oldJobs++;remove.push(id);
    for(const key of [
      `recover:acq:${id}`,
      `recover:acq:${id}:results`,
      `recover:acq:${id}:raw`,
      `recover:acq:${id}:lease`,
      `recover:acquisition:enqueue-lock:${id}`
    ]){multi.del(key);deletedJobKeys++;}
  }
  if(remove.length)multi.sRem(INDEX,remove);
  await multi.exec();
}

const queueKeys=(await redis.keys("recover:acquisition:queue*"))
  .filter(k=>k!=="recover:acquisition:queue:law-firm");
if(queueKeys.length)await redis.del(queueKeys);

const yieldKeys=await redis.keys("recover:yield:*");
if(yieldKeys.length)await redis.del(yieldKeys);
await redis.del("recover:coverage:v1","recover:coverage:area:consumed:v1","recover:leadstore:ny-home-comfort");
await redis.del(
  "recover:law-firm:seeded:v1",
  "recover:law-firm:enriched:v1",
  "recover:law-firm:ready:v1",
  "recover:law-firm:stats:v1"
);

let lawCandidates=0,backfilled=0;
for await (const page of redis.hScanIterator(LEAD_HASH,{COUNT:500})){
  for(const entry of (Array.isArray(page)?page:[page])){
    if(!entry?.field||entry.value===undefined)continue;
    let lead;try{lead=JSON.parse(entry.value)||{};}catch{continue;}
    const isLaw=String(lead.search_profile||"")==="law-firm" ||
      String(lead.industry||"").toUpperCase()==="LAW_FIRM";
    if(!isLaw)continue;
    lawCandidates++;
    const added=await redis.sAdd(PENDING_SET,entry.field);
    backfilled+=Number(added||0);
  }
}

const [indexAfter,pendingAfter]=await Promise.all([redis.sCard(INDEX),redis.sCard(PENDING_SET)]);
console.log(JSON.stringify({
  event:"law_firm_campaign_cleanup",
  indexed_before:ids.length,
  law_jobs_preserved:lawJobs,
  old_jobs_removed:oldJobs,
  deleted_job_keys:deletedJobKeys,
  old_queue_keys_deleted:queueKeys.length,
  old_yield_keys_deleted:yieldKeys.length,
  index_after:indexAfter,
  law_candidates:lawCandidates,
  enrichment_pending_added:backfilled,
  enrichment_pending_total:pendingAfter
},null,2));
await redis.quit();
