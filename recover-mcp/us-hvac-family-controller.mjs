import { createClient } from 'redis';
import { randomUUID } from 'node:crypto';
import { claimCoverage, campaignLeadSetKey } from './acquisition-coverage.mjs';
import { FAMILY_SHARDS, queryPassForIndex, workUnitForCursor } from './national-family-sharding.mjs';

const REDIS_URL=process.env.ACQUISITION_REDIS_URL||process.env.REDIS_URL||'';
if(!REDIS_URL) throw new Error('ACQUISITION_REDIS_URL required');

const ZIP_SOURCE_URL=process.env.US_ZIP_SOURCE_URL||'https://raw.githubusercontent.com/ReadyAPIs-com/curated-us-zips/main/data/us-zips.csv';
const TARGET_TOTAL=Number(process.env.US_HVAC_TARGET_TOTAL||100000);
const QUEUE_HIGH_WATER=Math.max(144,Number(process.env.US_FAMILY_QUEUE_HIGH_WATER||288));
const SEED_BATCH_SIZE=Math.max(12,Number(process.env.US_FAMILY_SEED_BATCH_SIZE||48));
const TARGET_PER_JOB=Math.max(8,Math.min(25,Number(process.env.US_FAMILY_TARGET_PER_JOB||18)));
const DEPTH=Math.max(6,Math.min(12,Number(process.env.US_FAMILY_DEPTH||6)));
const LOOP_MS=Math.max(5000,Number(process.env.US_FAMILY_CONTROLLER_LOOP_MS||10000));
const TTL=Number(process.env.ACQUISITION_TTL_SECONDS||604800);
const ACTIVE_QUEUE='recover:acquisition:queue';
const CONTROLLER_KEY='recover:controller:us-core-family:v4';
const BATCH_ID=process.env.US_FAMILY_BATCH_ID||'us-core-home-service-100k-family-v4-2026-09-12';

const profileJob={industry:'HVAC',require_no_website:true,require_contact:true,require_phone:false,require_email:false,include_no_website:true,min_score:30};

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

function partitionNationwideAreas(rows){
  const states=new Map();
  for(const row of rows){
    if(!states.has(row.state)) states.set(row.state,[]);
    states.get(row.state).push(row);
  }
  const queues=[...states.entries()].map(([state,items])=>({state,items:items.sort((a,b)=>b.population-a.population||a.zip.localeCompare(b.zip)),cursor:0,population:items.reduce((s,x)=>s+x.population,0)}));
  queues.sort((a,b)=>b.population-a.population||a.state.localeCompare(b.state));
  const out=[];
  for(;;){
    let added=0;
    for(const q of queues){
      if(q.cursor>=q.items.length) continue;
      out.push(q.items[q.cursor++]); added++;
    }
    if(!added) break;
  }
  return out;
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
  return partitionNationwideAreas(out);
}

const redis=createClient({url:REDIS_URL});
redis.on('error',e=>console.error('Redis error',e));
await redis.connect();
const areas=await fetchZipAreas();
const totalWorkUnits=areas.length*FAMILY_SHARDS.length;
const scopeSet=campaignLeadSetKey(profileJob);
let cursor=Math.max(0,Number(await redis.hGet(CONTROLLER_KEY,'cursor')||0));
console.log('US family shard controller started',JSON.stringify({areas:areas.length,families:FAMILY_SHARDS.length,totalWorkUnits,cursor,queueHighWater:QUEUE_HIGH_WATER,seedBatchSize:SEED_BATCH_SIZE,target:TARGET_TOTAL}));

async function enqueueUnit(unit){
  const {area,family}=unit;
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
  await redis.sAdd(`recover:batch:${BATCH_ID}:jobs`,id);
  await redis.expire(`recover:batch:${BATCH_ID}:jobs`,TTL);
  await redis.lPush(ACTIVE_QUEUE,id);
  return true;
}

while(true){
  try{
    const scoped=await redis.sCard(scopeSet);
    if(scoped>=TARGET_TOTAL){
      console.log(JSON.stringify({event:'family_target_reached',scoped,target:TARGET_TOTAL,cursor,totalWorkUnits}));
      await new Promise(r=>setTimeout(r,60000));
      continue;
    }
    const queue=await redis.lLen(ACTIVE_QUEUE);
    if(queue>=QUEUE_HIGH_WATER){
      console.log(JSON.stringify({event:'family_backpressure',scoped,queue,cursor,totalWorkUnits}));
      await new Promise(r=>setTimeout(r,LOOP_MS));
      continue;
    }
    let seeded=0,checked=0;
    while(seeded<SEED_BATCH_SIZE && cursor<totalWorkUnits && (await redis.lLen(ACTIVE_QUEUE))<QUEUE_HIGH_WATER){
      const unit=workUnitForCursor(areas,cursor);
      cursor++;
      checked++;
      if(unit && await enqueueUnit(unit)) seeded++;
    }
    await redis.hSet(CONTROLLER_KEY,{cursor:String(cursor),updated_at:new Date().toISOString(),total_work_units:String(totalWorkUnits)});
    console.log(JSON.stringify({event:'family_seed_cycle',scoped,queue_before:queue,checked,seeded,cursor,totalWorkUnits,area_index:Math.floor(cursor/FAMILY_SHARDS.length)}));
    if(cursor>=totalWorkUnits){
      console.log(JSON.stringify({event:'family_pass_complete',scoped,cursor,totalWorkUnits}));
      await new Promise(r=>setTimeout(r,60000));
    }else{
      await new Promise(r=>setTimeout(r,LOOP_MS));
    }
  }catch(error){
    console.error('family_controller_error',error);
    await new Promise(r=>setTimeout(r,15000));
  }
}
