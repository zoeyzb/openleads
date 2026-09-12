import { createClient } from 'redis';
import { randomUUID } from 'node:crypto';
import { claimCoverage, campaignLeadSetKey } from './acquisition-coverage.mjs';
import { FAMILY_SHARDS, queryPassForIndex } from './national-family-sharding.mjs';
import { buildYieldStats, rankFamilies, buildProductiveFamilySchedule, prioritizeAreas, buildCoverageYieldSchedule, buildCityFirstCoverageAreas, searchLocationForMode } from './national-yield-priority.mjs';
import { sampleSetMembers } from './redis-sampling.mjs';

const REDIS_URL=process.env.ACQUISITION_REDIS_URL||process.env.REDIS_URL||'';
if(!REDIS_URL) throw new Error('ACQUISITION_REDIS_URL required');

const ZIP_SOURCE_URL=process.env.US_ZIP_SOURCE_URL||'https://raw.githubusercontent.com/ReadyAPIs-com/curated-us-zips/main/data/us-zips.csv';
const TARGET_TOTAL=Number(process.env.US_HVAC_TARGET_TOTAL||100000);
const QUEUE_HIGH_WATER=Math.max(288,Number(process.env.US_FAMILY_QUEUE_HIGH_WATER||768));
const SEED_BATCH_SIZE=Math.max(24,Number(process.env.US_FAMILY_SEED_BATCH_SIZE||128));
const CITY_PRIORITY_TARGET=Math.max(16,Math.min(256,Number(process.env.US_FAMILY_CITY_PRIORITY_TARGET||64)));
const COVERAGE_SHARE=Math.min(0.95,Math.max(0.5,Number(process.env.US_FAMILY_COVERAGE_SHARE||0.70)));
const TARGET_PER_JOB=Math.max(8,Math.min(25,Number(process.env.US_FAMILY_TARGET_PER_JOB||18)));
const DEPTH=Math.max(6,Math.min(12,Number(process.env.US_FAMILY_DEPTH||6)));
const LOOP_MS=Math.max(3000,Number(process.env.US_FAMILY_CONTROLLER_LOOP_MS||5000));
const YIELD_SAMPLE_SIZE=Math.max(100,Math.min(2000,Number(process.env.US_FAMILY_YIELD_SAMPLE_SIZE||800)));
const YIELD_REFRESH_MS=Math.max(15000,Number(process.env.US_FAMILY_YIELD_REFRESH_MS||60000));
const TTL=Number(process.env.ACQUISITION_TTL_SECONDS||604800);
const ACTIVE_QUEUE='recover:acquisition:queue';
const CITY_PRIORITY_QUEUE='recover:acquisition:queue:us-city-priority';
const CONTROLLER_KEY='recover:controller:us-core-family:v7';
const PREVIOUS_CONTROLLER_KEY='recover:controller:us-core-family:v6';
const BATCH_ID=process.env.US_FAMILY_BATCH_ID||'us-core-home-service-100k-family-v4-2026-09-12';
const BATCH_JOB_SET=`recover:batch:${BATCH_ID}:jobs`;

const profileJob={industry:'HVAC',require_no_website:true,require_contact:true,require_phone:false,require_email:false,include_no_website:true,min_score:30};
const familyByKey=new Map(FAMILY_SHARDS.map(f=>[f.key,f]));
const familyKeys=FAMILY_SHARDS.map(f=>f.key);

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

async function fetchZipRows(){
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
  return out;
}

const redis=createClient({url:REDIS_URL});
redis.on('error',e=>console.error('Redis error',e));
await redis.connect();
const sourceAreas=await fetchZipRows();
const coverageAreas=buildCityFirstCoverageAreas(sourceAreas);
const yieldAreas=prioritizeAreas(sourceAreas);
const uniqueCities=new Set(sourceAreas.map(x=>`${x.state}|${x.city.toLowerCase()}`)).size;
const totalWorkUnits=sourceAreas.length*FAMILY_SHARDS.length;
const scopeSet=campaignLeadSetKey(profileJob);
const coverageCursors={};
const yieldCursors={};
for(const family of FAMILY_SHARDS){
  const storedCoverage=await redis.hGet(CONTROLLER_KEY,`coverage_cursor:${family.key}`);
  coverageCursors[family.key]=storedCoverage===null?0:Math.max(0,Number(storedCoverage)||0);
  const storedYield=await redis.hGet(CONTROLLER_KEY,`yield_cursor:${family.key}`);
  const previous=await redis.hGet(PREVIOUS_CONTROLLER_KEY,`yield_cursor:${family.key}`);
  yieldCursors[family.key]=storedYield===null?Math.max(0,Number(previous)||0):Math.max(0,Number(storedYield)||0);
}
let scheduleCursor=Math.max(0,Number(await redis.hGet(CONTROLLER_KEY,'schedule_cursor')||0));
let coverageFloorCursor=Math.max(0,Number(await redis.hGet(CONTROLLER_KEY,'coverage_floor_cursor')||0));
let yieldStats={};
let lastYieldRefresh=0;

console.log('US city-first adaptive family controller started',JSON.stringify({zipAreas:sourceAreas.length,uniqueCities,families:FAMILY_SHARDS.length,totalWorkUnits,coverageCursors,yieldCursors,coverageShare:COVERAGE_SHARE,cityPriorityTarget:CITY_PRIORITY_TARGET,queueHighWater:QUEUE_HIGH_WATER,seedBatchSize:SEED_BATCH_SIZE,target:TARGET_TOTAL,coverageQueryMode:'city-state'}));

async function pendingQueueDepth(){
  const [general,city]=await Promise.all([redis.lLen(ACTIVE_QUEUE),redis.lLen(CITY_PRIORITY_QUEUE)]);
  return {general,city,total:general+city};
}

async function refreshYieldStats(){
  if(Date.now()-lastYieldRefresh<YIELD_REFRESH_MS) return yieldStats;
  lastYieldRefresh=Date.now();
  try{
    const ids=await sampleSetMembers(redis,BATCH_JOB_SET,YIELD_SAMPLE_SIZE);
    if(!ids.length){ yieldStats={}; return yieldStats; }
    const payloads=await redis.mGet(ids.map(id=>`recover:acq:${id}`));
    const jobs=[];
    for(const payload of payloads){
      if(!payload) continue;
      try{
        const job=JSON.parse(payload);
        if(String(job?.search_profile||'')==='core-home-service' && String(job?.service_family||'')) jobs.push(job);
      }catch{}
    }
    yieldStats=buildYieldStats(jobs);
    console.log(JSON.stringify({event:'family_yield_refresh',sampled:jobs.length,stats:yieldStats}));
  }catch(error){
    console.warn('family_yield_refresh_failed',String(error?.message||error));
  }
  return yieldStats;
}

async function enqueueUnit(area,family,mode){
  const searchLocation=searchLocationForMode(area,mode);
  const coveragePass=queryPassForIndex(searchLocation,family.queryIndex,`us-core-family-v5-${mode}-${family.key}`);
  const id=randomUUID(); const now=new Date().toISOString();
  const job={
    id,batch_id:BATCH_ID,industry:'HVAC',search_profile:'core-home-service',coverage_pass:coveragePass,
    partition_state:area.state,partition_city:area.city,partition_zip:area.zip,
    service_family:family.key,service_query_index:family.queryIndex,service_query_label:family.label,
    location:searchLocation,target:TARGET_PER_JOB,min_score:30,
    require_phone:false,require_email:false,require_contact:true,require_no_website:true,include_no_website:true,
    max_rounds:1,depth:DEPTH,status:'queued',phase:'queued',round:0,rounds_completed:0,
    raw_count:0,unique_count:0,qualified_count:0,stored_count:0,maps_jobs:[],
    source:'us_core_family_partition_controller_v5',source_zip:area.zip,source_population:area.population,
    scheduler_mode:mode,search_location_mode:mode==='coverage'?'city-state':'zip-city-state',created_at:now,updated_at:now
  };
  const claim=await claimCoverage(redis,job,{source:job.source,service_family:family.key,query_index:family.queryIndex});
  if(!claim.claimed) return false;
  await redis.set(`recover:acq:${id}`,JSON.stringify(job),{EX:TTL});
  await redis.sAdd('recover:acq:index',id);
  await redis.sAdd(BATCH_JOB_SET,id);
  await redis.expire(BATCH_JOB_SET,TTL);
  await redis.lPush(mode==='coverage'?CITY_PRIORITY_QUEUE:ACTIVE_QUEUE,id);
  return true;
}

async function enqueueNext(mode,familyKey){
  const family=familyByKey.get(familyKey);
  if(!family) return {seeded:false,checked:0,exhausted:true};
  const areas=mode==='coverage'?coverageAreas:yieldAreas;
  const cursors=mode==='coverage'?coverageCursors:yieldCursors;
  let checked=0;
  while(cursors[familyKey]<areas.length){
    const area=areas[cursors[familyKey]++];
    checked++;
    if(await enqueueUnit(area,family,mode)) return {seeded:true,checked,exhausted:false};
  }
  return {seeded:false,checked,exhausted:true};
}

function allWorkExhausted(){
  return FAMILY_SHARDS.every(f=>coverageCursors[f.key]>=coverageAreas.length && yieldCursors[f.key]>=yieldAreas.length);
}

async function persistControllerState(){
  const state={updated_at:new Date().toISOString(),total_work_units:String(totalWorkUnits),unique_cities:String(uniqueCities),schedule_cursor:String(scheduleCursor),coverage_floor_cursor:String(coverageFloorCursor),coverage_share:String(COVERAGE_SHARE)};
  for(const family of FAMILY_SHARDS){
    state[`coverage_cursor:${family.key}`]=String(coverageCursors[family.key]);
    state[`yield_cursor:${family.key}`]=String(yieldCursors[family.key]);
  }
  await redis.hSet(CONTROLLER_KEY,state);
}

async function maintainCityPriorityFloor(queue,ranked){
  let seeded=0,checked=0;
  const productive=buildProductiveFamilySchedule(ranked,CITY_PRIORITY_TARGET*2,0.20,coverageFloorCursor);
  while(queue.city<CITY_PRIORITY_TARGET && seeded<SEED_BATCH_SIZE){
    const family=productive[coverageFloorCursor%productive.length]||ranked[0]||familyKeys[0];
    coverageFloorCursor++;
    const result=await enqueueNext('coverage',family);
    checked+=result.checked;
    if(result.seeded){ seeded++; queue.city++; queue.total++; }
    if(result.exhausted && FAMILY_SHARDS.every(f=>coverageCursors[f.key]>=coverageAreas.length)) break;
  }
  if(seeded){
    await persistControllerState();
    console.log(JSON.stringify({event:'family_city_priority_floor_refill',seeded,checked,city_after:queue.city,total_after:queue.total,cityPriorityTarget:CITY_PRIORITY_TARGET,ranked,coverageCursors}));
  }
  return seeded;
}

while(true){
  try{
    const scoped=await redis.sCard(scopeSet);
    if(scoped>=TARGET_TOTAL){
      console.log(JSON.stringify({event:'family_target_reached',scoped,target:TARGET_TOTAL,totalWorkUnits,uniqueCities,coverageCursors,yieldCursors}));
      await new Promise(r=>setTimeout(r,60000));
      continue;
    }
    await refreshYieldStats();
    const ranked=rankFamilies(familyKeys,yieldStats);
    const queue=await pendingQueueDepth();
    if(queue.city<CITY_PRIORITY_TARGET){
      await maintainCityPriorityFloor(queue,ranked);
    }
    if(queue.total>=QUEUE_HIGH_WATER){
      console.log(JSON.stringify({event:'family_backpressure',scoped,queue,ranked,yieldStats,totalWorkUnits,uniqueCities,coverageCursors,yieldCursors}));
      await new Promise(r=>setTimeout(r,LOOP_MS));
      continue;
    }

    const schedule=buildCoverageYieldSchedule(familyKeys,ranked,Math.max(SEED_BATCH_SIZE*2,familyKeys.length),COVERAGE_SHARE);
    let seeded=0,checked=0,coverageSeeded=0,yieldSeeded=0;
    while(seeded<SEED_BATCH_SIZE && (await pendingQueueDepth()).total<QUEUE_HIGH_WATER && !allWorkExhausted()){
      const slot=schedule[scheduleCursor%schedule.length];
      scheduleCursor++;
      const result=await enqueueNext(slot.mode,slot.family);
      checked+=result.checked;
      if(result.seeded){
        seeded++;
        if(slot.mode==='coverage') coverageSeeded++; else yieldSeeded++;
      }
    }
    await persistControllerState();
    const queueAfter=await pendingQueueDepth();
    console.log(JSON.stringify({event:'family_city_coverage_seed_cycle',scoped,queue_before:queue,queue_after:queueAfter,checked,seeded,coverageSeeded,yieldSeeded,ranked,yieldStats,uniqueCities,coverageCursors,yieldCursors,totalWorkUnits}));
    if(allWorkExhausted()){
      console.log(JSON.stringify({event:'family_pass_complete',scoped,totalWorkUnits,uniqueCities,coverageCursors,yieldCursors}));
      await new Promise(r=>setTimeout(r,60000));
    }else{
      await new Promise(r=>setTimeout(r,LOOP_MS));
    }
  }catch(error){
    console.error('family_controller_error',error);
    await new Promise(r=>setTimeout(r,15000));
  }
}
