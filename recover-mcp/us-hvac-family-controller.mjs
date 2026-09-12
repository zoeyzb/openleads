import { createClient } from 'redis';
import { randomUUID } from 'node:crypto';
import { claimCoverage, campaignLeadSetKey } from './acquisition-coverage.mjs';
import { FAMILY_SHARDS, queryPassForIndex } from './national-family-sharding.mjs';
import { buildYieldStats, rankFamilies, weightedFamilySchedule, prioritizeAreas } from './national-yield-priority.mjs';

const REDIS_URL=process.env.ACQUISITION_REDIS_URL||process.env.REDIS_URL||'';
if(!REDIS_URL) throw new Error('ACQUISITION_REDIS_URL required');

const ZIP_SOURCE_URL=process.env.US_ZIP_SOURCE_URL||'https://raw.githubusercontent.com/ReadyAPIs-com/curated-us-zips/main/data/us-zips.csv';
const TARGET_TOTAL=Number(process.env.US_HVAC_TARGET_TOTAL||100000);
const QUEUE_HIGH_WATER=Math.max(288,Number(process.env.US_FAMILY_QUEUE_HIGH_WATER||576));
const SEED_BATCH_SIZE=Math.max(24,Number(process.env.US_FAMILY_SEED_BATCH_SIZE||96));
const TARGET_PER_JOB=Math.max(8,Math.min(25,Number(process.env.US_FAMILY_TARGET_PER_JOB||18)));
const DEPTH=Math.max(6,Math.min(12,Number(process.env.US_FAMILY_DEPTH||6)));
const LOOP_MS=Math.max(3000,Number(process.env.US_FAMILY_CONTROLLER_LOOP_MS||5000));
const YIELD_SAMPLE_SIZE=Math.max(100,Math.min(2000,Number(process.env.US_FAMILY_YIELD_SAMPLE_SIZE||800)));
const YIELD_REFRESH_MS=Math.max(15000,Number(process.env.US_FAMILY_YIELD_REFRESH_MS||60000));
const TTL=Number(process.env.ACQUISITION_TTL_SECONDS||604800);
const ACTIVE_QUEUE='recover:acquisition:queue';
const CONTROLLER_KEY='recover:controller:us-core-family:v5';
const LEGACY_CONTROLLER_KEY='recover:controller:us-core-family:v4';
const BATCH_ID=process.env.US_FAMILY_BATCH_ID||'us-core-home-service-100k-family-v4-2026-09-12';
const BATCH_JOB_SET=`recover:batch:${BATCH_ID}:jobs`;

const profileJob={industry:'HVAC',require_no_website:true,require_contact:true,require_phone:false,require_email:false,include_no_website:true,min_score:30};
const familyByKey=new Map(FAMILY_SHARDS.map(f=>[f.key,f]));

function parseCsvLine(line){
  const out=[]; let cell='',quoted=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(quoted){
      if(ch==='"'&&line[i+1]==='"'){cell+='"';i++;}
      else if(ch==='"') quoted=false;
      else cell+=ch;
    }else{
      if(ch==='"') quoted=true;
      else if(ch===','){out.push(cell);cell='';}
      else cell+=ch;
    }
  }
  out.push(cell); return out;
}

async function fetchZipAreas(){
  const res=await fetch(ZIP_SOURCE_URL,{headers:{'user-agent':'Recover-Scrape/1.0'}});
  if(!res.ok) throw new Error(`zip source failed ${res.status}`);
  const lines=(await res.text()).split(/\r?\n/).filter(Boolean);
  const header=parseCsvLine(lines.shift()||'').map(x=>x.trim());
  const idx=Object.fromEntries(header.map((x,i)=>[x,i]));
  const out=[];
  for(const line of lines){
    const row=parseCsvLine(line);
    const zip=String(row[idx.zip_code]||'').trim().padStart(5,'0');
    const city=String(row[idx.city]||'').trim();
    const state=String(row[idx.state]||'').trim().toUpperCase();
    const population=Number(String(row[idx.population]||'0').replace(/[^0-9.-]/g,''))||0;
    if(!/^\d{5}$/.test(zip)||!city||!/^[A-Z]{2}$/.test(state)) continue;
    if(['PR','VI','GU','AS','MP'].includes(state)) continue;
    out.push({zip,city,state,population,location:`${zip} ${city}, ${state}`});
  }
  if(!out.length) throw new Error('zip source parsed zero areas');
  return prioritizeAreas(out);
}

const redis=createClient({url:REDIS_URL});
redis.on('error',e=>console.error('Redis error',e));
await redis.connect();
const areas=await fetchZipAreas();
const totalWorkUnits=areas.length*FAMILY_SHARDS.length;
const scopeSet=campaignLeadSetKey(profileJob);
const legacyCursor=Math.max(0,Number(await redis.hGet(LEGACY_CONTROLLER_KEY,'cursor')||0));
const legacyAreaCursor=Math.floor(legacyCursor/FAMILY_SHARDS.length);
const familyCursors={};
for(const family of FAMILY_SHARDS){
  const stored=await redis.hGet(CONTROLLER_KEY,`cursor:${family.key}`);
  familyCursors[family.key]=stored===null?legacyAreaCursor:Math.max(0,Number(stored)||0);
}
let scheduleCursor=Math.max(0,Number(await redis.hGet(CONTROLLER_KEY,'schedule_cursor')||0));
let yieldStats={};
let lastYieldRefresh=0;

console.log('US adaptive family shard controller started',JSON.stringify({areas:areas.length,families:FAMILY_SHARDS.length,totalWorkUnits,legacyAreaCursor,familyCursors,queueHighWater:QUEUE_HIGH_WATER,seedBatchSize:SEED_BATCH_SIZE,target:TARGET_TOTAL}));

async function refreshYieldStats(){
  if(Date.now()-lastYieldRefresh<YIELD_REFRESH_MS) return yieldStats;
  lastYieldRefresh=Date.now();
  try{
    const sampled=await redis.sendCommand(['SRANDMEMBER',BATCH_JOB_SET,String(YIELD_SAMPLE_SIZE)]);
    const ids=Array.isArray(sampled)?sampled:(sampled?[sampled]:[]);
    if(!ids.length){ yieldStats={}; return yieldStats; }
    const payloads=await redis.mGet(ids.map(id=>`recover:acq:${id}`));
    const jobs=[];
    for(const payload of payloads){
      if(!payload) continue;
      try{ jobs.push(JSON.parse(payload)); }catch{}
    }
    yieldStats=buildYieldStats(jobs);
    console.log(JSON.stringify({event:'family_yield_refresh',sampled:jobs.length,stats:yieldStats}));
  }catch(error){
    console.warn('family_yield_refresh_failed',String(error?.message||error));
  }
  return yieldStats;
}

async function enqueueUnit(area,family){
  const coveragePass=queryPassForIndex(area.location,family.queryIndex,`us-core-family-v4-${family.key}`);
  const id=randomUUID(); const now=new Date().toISOString();
  const job={
    id,batch_id:BATCH_ID,industry:'HVAC',search_profile:'core-home-service',coverage_pass:coveragePass,
    partition_state:area.state,partition_city:area.city,partition_zip:area.zip,
    service_family:family.key,service_query_index:family.queryIndex,service_query_label:family.label,
    location:area.location,target:TARGET_PER_JOB,min_score:30,
    require_phone:false,require_email:false,require_contact:true,require_no_website:true,include_no_website:true,
    max_rounds:1,depth:DEPTH,status:'queued',phase:'queued',round:0,rounds_completed:0,
    raw_count:0,unique_count:0,qualified_count:0,stored_count:0,maps_jobs:[],
    source:'us_core_family_partition_controller_v4',source_zip:area.zip,source_population:area.population,
    created_at:now,updated_at:now
  };
  const claim=await claimCoverage(redis,job,{source:job.source,service_family:family.key,query_index:family.queryIndex});
  if(!claim.claimed) return false;
  await redis.set(`recover:acq:${id}`,JSON.stringify(job),{EX:TTL});
  await redis.sAdd('recover:acq:index',id);
  await redis.sAdd(BATCH_JOB_SET,id);
  await redis.expire(BATCH_JOB_SET,TTL);
  await redis.lPush(ACTIVE_QUEUE,id);
  return true;
}

async function enqueueNextForFamily(familyKey){
  const family=familyByKey.get(familyKey);
  if(!family) return {seeded:false,checked:0,exhausted:true};
  let checked=0;
  while(familyCursors[familyKey]<areas.length){
    const area=areas[familyCursors[familyKey]++];
    checked++;
    if(await enqueueUnit(area,family)) return {seeded:true,checked,exhausted:false};
  }
  return {seeded:false,checked,exhausted:true};
}

function allFamiliesExhausted(){
  return FAMILY_SHARDS.every(f=>familyCursors[f.key]>=areas.length);
}

async function persistControllerState(){
  const state={updated_at:new Date().toISOString(),total_work_units:String(totalWorkUnits),schedule_cursor:String(scheduleCursor)};
  for(const family of FAMILY_SHARDS) state[`cursor:${family.key}`]=String(familyCursors[family.key]);
  await redis.hSet(CONTROLLER_KEY,state);
}

while(true){
  try{
    const scoped=await redis.sCard(scopeSet);
    if(scoped>=TARGET_TOTAL){
      console.log(JSON.stringify({event:'family_target_reached',scoped,target:TARGET_TOTAL,totalWorkUnits,familyCursors}));
      await new Promise(r=>setTimeout(r,60000));
      continue;
    }
    const queue=await redis.lLen(ACTIVE_QUEUE);
    if(queue>=QUEUE_HIGH_WATER){
      console.log(JSON.stringify({event:'family_backpressure',scoped,queue,totalWorkUnits,familyCursors}));
      await new Promise(r=>setTimeout(r,LOOP_MS));
      continue;
    }

    await refreshYieldStats();
    const ranked=rankFamilies(FAMILY_SHARDS.map(f=>f.key),yieldStats);
    const schedule=weightedFamilySchedule(ranked,Math.max(SEED_BATCH_SIZE*2,ranked.length));
    let seeded=0,checked=0;
    while(seeded<SEED_BATCH_SIZE && (await redis.lLen(ACTIVE_QUEUE))<QUEUE_HIGH_WATER && !allFamiliesExhausted()){
      const familyKey=schedule[scheduleCursor%schedule.length];
      scheduleCursor++;
      const result=await enqueueNextForFamily(familyKey);
      checked+=result.checked;
      if(result.seeded) seeded++;
    }
    await persistControllerState();
    console.log(JSON.stringify({event:'family_adaptive_seed_cycle',scoped,queue_before:queue,checked,seeded,ranked,yieldStats,familyCursors,totalWorkUnits}));
    if(allFamiliesExhausted()){
      console.log(JSON.stringify({event:'family_pass_complete',scoped,totalWorkUnits,familyCursors}));
      await new Promise(r=>setTimeout(r,60000));
    }else{
      await new Promise(r=>setTimeout(r,LOOP_MS));
    }
  }catch(error){
    console.error('family_controller_error',error);
    await new Promise(r=>setTimeout(r,15000));
  }
}
