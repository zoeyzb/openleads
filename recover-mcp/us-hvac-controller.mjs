import { createClient } from "redis";
import { randomUUID } from "node:crypto";
import { claimCoverage, campaignLeadSetKey, qualificationProfile } from "./acquisition-coverage.mjs";
import { isCoreHomeServiceLead } from "./home-service-targeting.mjs";

const REDIS_URL=process.env.ACQUISITION_REDIS_URL||"";
if(!REDIS_URL) throw new Error("ACQUISITION_REDIS_URL required");

const ZIP_SOURCE_URL=process.env.US_ZIP_SOURCE_URL||
  "https://raw.githubusercontent.com/ReadyAPIs-com/curated-us-zips/main/data/us-zips.csv";
const TARGET_TOTAL=Number(process.env.US_HVAC_TARGET_TOTAL||100000);
const NY_FIRST_MILESTONE=Number(process.env.NY_HOME_COMFORT_FIRST_MILESTONE||1000);
const ENFORCE_NY_FIRST=String(process.env.ENFORCE_NY_FIRST_MILESTONE||"0")==="1";
const NY_SCOPE_SET="recover:leadstore:ny-home-comfort";
const FIRST_MILESTONE=Number(process.env.US_HVAC_FIRST_MILESTONE||1000);
const QUEUE_HIGH_WATER=Math.min(Number(process.env.US_HVAC_QUEUE_HIGH_WATER||72),72);
const SEED_BATCH_SIZE=Math.min(Number(process.env.US_HVAC_SEED_BATCH_SIZE||18),18);
const TARGET_PER_AREA=Math.min(Number(process.env.US_HVAC_ZIP_TARGET_PER_AREA||18),18);
const DEPTH=Math.min(Number(process.env.US_HVAC_ZIP_DEPTH||6),6);
const MAX_ROUNDS=1;
const LOOP_MS=Number(process.env.US_HVAC_CONTROLLER_LOOP_MS||15000);
const TTL=Number(process.env.ACQUISITION_TTL_SECONDS||604800);
const CONTROLLER_KEY="recover:controller:us-core-home-service:v2";
const BATCH_ID=process.env.US_HVAC_BATCH_ID||"us-core-home-service-100k-v2-2026-09-10";
const PAUSED_NATIONAL_QUEUE="recover:acquisition:queue:paused-national";
const ACTIVE_QUEUE="recover:acquisition:queue";
const NY_PRIORITY_QUEUE="recover:acquisition:queue:ny-priority";
const PAUSED_NY_SURPLUS_QUEUE="recover:acquisition:queue:paused-ny-surplus";
const PAUSED_LEGACY_NATIONAL_QUEUE="recover:acquisition:queue:paused-legacy-national-v1";

const profileJob={
  industry:"HVAC",
  require_no_website:true,
  require_contact:true,
  require_phone:false,
  require_email:false,
  include_no_website:true,
  min_score:30
};

function isNyLocation(value=""){
  return /\\bny\\b|new york/i.test(String(value||""));
}
function isHomeComfortLead(lead={}){
  return isCoreHomeServiceLead(lead);
}
async function bootstrapNyScope(redis){
  const before=await redis.sCard(NY_SCOPE_SET);
  const all=await redis.hGetAll("recover:leadstore:qualified");
  const ids=[];
  for(const [identity,raw] of Object.entries(all)){
    let lead; try{lead=JSON.parse(raw)}catch{continue}
    if(String(lead.website||"").trim()) continue;
    const hasContact=String(lead.phone||"").trim() || (Array.isArray(lead.emails)&&lead.emails.length) || String(lead.email||"").trim();
    if(!hasContact || !isCoreHomeServiceLead(lead)) continue;
    if(!isNyLocation(lead.acquisition_location||lead.region||lead.state||lead.address||"")) continue;
    ids.push(identity);
  }
  const temp=NY_SCOPE_SET+":rebuild:"+Date.now();
  if(ids.length){
    for(let i=0;i<ids.length;i+=500) await redis.sAdd(temp,ids.slice(i,i+500));
    await redis.rename(temp,NY_SCOPE_SET);
  }else{
    await redis.del(NY_SCOPE_SET);
  }
  const total=await redis.sCard(NY_SCOPE_SET);
  console.log(JSON.stringify({event:"ny_scope_rebuild",before,total,removed:Math.max(0,before-total)}));
  return total;
}

function parseCsvLine(line){
  const out=[]; let cell="", quoted=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(quoted){
      if(ch==='"' && line[i+1]==='"'){ cell+='"'; i++; }
      else if(ch==='"') quoted=false;
      else cell+=ch;
    }else{
      if(ch==='"') quoted=true;
      else if(ch===','){ out.push(cell); cell=""; }
      else cell+=ch;
    }
  }
  out.push(cell);
  return out;
}

async function bootstrapScopedLeads(redis, scopeSet){
  const before=await redis.sCard(scopeSet);
  const all=await redis.hGetAll("recover:leadstore:qualified");
  const ids=[];
  const emailList=v=>{
    const arr=Array.isArray(v)?v:String(v||"").split(/[;,\s]+/);
    return arr.map(x=>String(x).trim().toLowerCase()).filter(x=>/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
  };
  for(const [identity,raw] of Object.entries(all)){
    let lead; try{lead=JSON.parse(raw)}catch{continue}
    if(String(lead.website||"").trim()) continue;
    if(!String(lead.phone||"").trim() && !emailList(lead.emails||lead.email||"").length) continue;
    if(!isCoreHomeServiceLead(lead)) continue;
    ids.push(identity);
  }
  const temp=scopeSet+":rebuild:"+Date.now();
  if(ids.length){
    for(let i=0;i<ids.length;i+=500) await redis.sAdd(temp,ids.slice(i,i+500));
    await redis.rename(temp,scopeSet);
  }else{
    await redis.del(scopeSet);
  }
  const total=await redis.sCard(scopeSet);
  console.log(JSON.stringify({event:"scope_rebuild",before,total,removed:Math.max(0,before-total)}));
  return total;
}

function partitionNationwideAreas(rows){
  const states=new Map();
  for(const row of rows){
    if(!states.has(row.state)) states.set(row.state,new Map());
    const cities=states.get(row.state);
    const cityKey=row.city.toLowerCase();
    if(!cities.has(cityKey)) cities.set(cityKey,{city:row.city,population:0,zips:[]});
    const city=cities.get(cityKey);
    city.population+=row.population;
    city.zips.push(row);
  }
  const stateQueues=[];
  for(const [state,citiesMap] of states){
    const cities=[...citiesMap.values()].sort((a,b)=>b.population-a.population||a.city.localeCompare(b.city));
    for(const city of cities) city.zips.sort((a,b)=>b.population-a.population||a.zip.localeCompare(b.zip));
    const ordered=[];
    for(let wave=0;;wave++){
      let added=0;
      for(const city of cities){
        const area=city.zips[wave];
        if(!area) continue;
        ordered.push({...area,partition_state:state,partition_city:city.city,partition_zip:area.zip});
        added++;
      }
      if(!added) break;
    }
    stateQueues.push({
      state,
      population:cities.reduce((sum,city)=>sum+city.population,0),
      ordered,
      cursor:0
    });
  }
  stateQueues.sort((a,b)=>b.population-a.population||a.state.localeCompare(b.state));
  const out=[];
  for(;;){
    let added=0;
    for(const state of stateQueues){
      if(state.cursor>=state.ordered.length) continue;
      out.push(state.ordered[state.cursor++]);
      added++;
    }
    if(!added) break;
  }
  return out;
}

async function fetchZipAreas(){
  const res=await fetch(ZIP_SOURCE_URL,{headers:{"user-agent":"Recover-Scrape/1.0"}});
  if(!res.ok) throw new Error("zip source failed "+res.status);
  const text=await res.text();
  const lines=text.split(/\r?\n/).filter(Boolean);
  if(lines.length<2) throw new Error("zip source empty");
  const header=parseCsvLine(lines[0]).map(x=>x.trim());
  const idx=Object.fromEntries(header.map((x,i)=>[x,i]));
  for(const key of ["zip_code","city","state","population"]){
    if(idx[key]===undefined) throw new Error("zip source missing column "+key);
  }

  const out=[];
  for(const line of lines.slice(1)){
    const row=parseCsvLine(line);
    const zip=String(row[idx.zip_code]||"").trim().padStart(5,"0");
    const city=String(row[idx.city]||"").trim();
    const state=String(row[idx.state]||"").trim().toUpperCase();
    const population=Number(String(row[idx.population]||"0").replace(/[^0-9.-]/g,""))||0;
    if(!/^\d{5}$/.test(zip) || !city || !/^[A-Z]{2}$/.test(state)) continue;
    if(["PR","VI","GU","AS","MP"].includes(state)) continue;
    out.push({
      zip,city,state,population,
      location:`${zip} ${city}, ${state}`
    });
  }

  if(!out.length) throw new Error("zip source parsed zero areas");
  return partitionNationwideAreas(out);
}

const redis=createClient({url:REDIS_URL});
redis.on("error",e=>console.error("Redis error",e));
await redis.connect();

const areas=await fetchZipAreas();
const scopeSet=campaignLeadSetKey(profileJob);
await bootstrapScopedLeads(redis,scopeSet);
await bootstrapNyScope(redis);
let cursor=Number(await redis.hGet(CONTROLLER_KEY,"cursor")||0);
let coveragePass=Math.max(1,Number(await redis.hGet(CONTROLLER_KEY,"coverage_pass")||1));
console.log("US HVAC ZIP controller started",JSON.stringify({
  areas:areas.length,target:TARGET_TOTAL,scopeSet,cursor,
  targetPerArea:TARGET_PER_AREA,maxRounds:MAX_ROUNDS,depth:DEPTH,
  queueHighWater:QUEUE_HIGH_WATER,coveragePass,partitioning:"state>city>zip",enforceNyFirst:ENFORCE_NY_FIRST
}));
await upgradeQueuedNationalJobs();
await parkLegacyNationalForV2();

async function parkNySurplus(){
  let moved=0,missing=0,already=0;
  while(true){
    const id=await redis.rPop(NY_PRIORITY_QUEUE);
    if(!id) break;
    const raw=await redis.get("recover:acq:"+id);
    if(!raw){missing++;continue;}
    let job; try{job=JSON.parse(raw)}catch{missing++;continue;}
    if(String(job.status||"")!=="queued") continue;
    job.status="parked";
    job.phase="parked_ny_surplus";
    job.updated_at=new Date().toISOString();
    await redis.set("recover:acq:"+id,JSON.stringify(job),{EX:TTL});
    const pos=await redis.lPos(PAUSED_NY_SURPLUS_QUEUE,String(id));
    if(pos===null){await redis.lPush(PAUSED_NY_SURPLUS_QUEUE,String(id));moved++;}
    else already++;
  }
  return {moved,missing,already,remainingPriority:await redis.lLen(NY_PRIORITY_QUEUE),pausedNySurplus:await redis.lLen(PAUSED_NY_SURPLUS_QUEUE)};
}

async function resumePausedNational(maxToMove){
  let moved=0, duplicates=0;
  const limit=Math.max(0,Number(maxToMove||0));
  while(moved<limit){
    const id=await redis.rPop(PAUSED_NATIONAL_QUEUE);
    if(!id) break;
    const pos=await redis.lPos(ACTIVE_QUEUE,String(id));
    if(pos===null){
      await redis.lPush(ACTIVE_QUEUE,String(id));
      moved++;
    }else{
      duplicates++;
    }
  }
  const remaining=await redis.lLen(PAUSED_NATIONAL_QUEUE);
  return {moved,duplicates,remaining};
}

async function parkLegacyNationalForV2(){
  const ids=await redis.lRange(ACTIVE_QUEUE,0,-1);
  let parked=0,keptV2=0,skipped=0;
  for(const id of ids){
    const raw=await redis.get("recover:acq:"+id);
    if(!raw){skipped++;continue;}
    let job; try{job=JSON.parse(raw)}catch{skipped++;continue;}
    if(String(job.status||"")!=="queued"){skipped++;continue;}
    const isV2=String(job.batch_id||"").startsWith("us-core-home-service-100k-v2") ||
      String(job.coverage_pass||"").startsWith("us-core-v2-");
    if(isV2){keptV2++;continue;}
    const removed=await redis.lRem(ACTIVE_QUEUE,1,String(id));
    if(!removed){skipped++;continue;}
    job.status="parked";
    job.phase="parked_legacy_national_v1";
    job.updated_at=new Date().toISOString();
    await redis.set("recover:acq:"+id,JSON.stringify(job),{EX:TTL});
    const pos=await redis.lPos(PAUSED_LEGACY_NATIONAL_QUEUE,String(id));
    if(pos===null) await redis.lPush(PAUSED_LEGACY_NATIONAL_QUEUE,String(id));
    parked++;
  }
  const result={
    event:"legacy_national_parked_for_v2",
    snapshot:ids.length,parked,keptV2,skipped,
    activeAfter:await redis.lLen(ACTIVE_QUEUE),
    pausedLegacy:await redis.lLen(PAUSED_LEGACY_NATIONAL_QUEUE)
  };
  console.log(JSON.stringify(result));
  return result;
}

async function upgradeQueuedNationalJobs(){
  const ids=await redis.lRange(ACTIVE_QUEUE,0,-1);
  let upgraded=0,skipped=0;
  for(const id of ids){
    const raw=await redis.get("recover:acq:"+id);
    if(!raw){skipped++;continue;}
    let job; try{job=JSON.parse(raw)}catch{skipped++;continue;}
    if(String(job.status||"")!=="queued" || Number(job.round||0)>0){skipped++;continue;}
    const industry=String(job.industry||"").toLowerCase();
    if(!/hvac|home.comfort|home.service|heating|cooling|plumb/.test(industry)){skipped++;continue;}
    job.search_profile="core-home-service";
    job.max_rounds=1;
    job.depth=Math.min(Number(job.depth||6),6);
    job.target=Math.min(Number(job.target||18),18);
    job.updated_at=new Date().toISOString();
    await redis.set("recover:acq:"+id,JSON.stringify(job),{EX:TTL});
    upgraded++;
  }
  console.log(JSON.stringify({event:"legacy_queue_upgraded",queue:ids.length,upgraded,skipped}));
  return upgraded;
}

async function seedOne(area){
  const id=randomUUID(), now=new Date().toISOString();
  const job={
    id,
    batch_id:BATCH_ID,
    industry:"HVAC",
    search_profile:"core-home-service",
    coverage_pass:`us-core-v2-p${coveragePass}`,
    partition_state:area.partition_state||area.state,
    partition_city:area.partition_city||area.city,
    partition_zip:area.partition_zip||area.zip,
    location:area.location,
    target:TARGET_PER_AREA,
    min_score:30,
    require_phone:false,
    require_email:false,
    require_contact:true,
    require_no_website:true,
    include_no_website:true,
    max_rounds:MAX_ROUNDS,
    depth:DEPTH,
    status:"queued",
    phase:"queued",
    round:0,
    rounds_completed:0,
    raw_count:0,
    unique_count:0,
    qualified_count:0,
    stored_count:0,
    maps_jobs:[],
    source:"us_core_partition_controller_v2",
    source_zip:area.zip,
    source_population:area.population,
    created_at:now,
    updated_at:now
  };

  const claim=await claimCoverage(redis,job,{
    source:"us_core_partition_controller_v2",
    source_zip:area.zip,
    source_population:area.population,
    partition_state:job.partition_state,
    partition_city:job.partition_city,
    coverage_pass:job.coverage_pass
  });
  if(!claim.claimed) return false;

  await redis.set("recover:acq:"+id,JSON.stringify(job),{EX:TTL});
  await redis.sAdd("recover:acq:index",id);
  await redis.sAdd("recover:batch:"+BATCH_ID+":jobs",id);
  await redis.expire("recover:batch:"+BATCH_ID+":jobs",TTL);
  const pos=await redis.lPos(ACTIVE_QUEUE,id);
  if(pos===null) await redis.lPush(ACTIVE_QUEUE,id);
  return true;
}

while(true){
  try{
    const scoped=await redis.sCard(scopeSet);
    const nyScoped=await redis.sCard(NY_SCOPE_SET);
    const queue=await redis.lLen(ACTIVE_QUEUE);
    const pausedNational=await redis.lLen(PAUSED_NATIONAL_QUEUE);

    await redis.hSet(CONTROLLER_KEY,{
      scoped_count:String(scoped),
      queue_len:String(queue),
      cursor:String(cursor),
      coverage_pass:String(coveragePass),
      partition_state:String(areas[cursor]?.partition_state||areas[cursor]?.state||""),
      partition_city:String(areas[cursor]?.partition_city||areas[cursor]?.city||""),
      area_count:String(areas.length),
      updated_at:new Date().toISOString(),
      milestone_1000:scoped>=FIRST_MILESTONE?"reached":"pending",
      ny_priority_count:String(nyScoped),
      ny_priority_milestone:nyScoped>=NY_FIRST_MILESTONE?"reached":"pending",
      paused_national_count:String(pausedNational),
      national_resume_state:(!ENFORCE_NY_FIRST || nyScoped>=NY_FIRST_MILESTONE)?(pausedNational>0?"draining_parked":"active"):"waiting_for_ny",
      target_100k:scoped>=TARGET_TOTAL?"reached":"pending"
    });

    if(ENFORCE_NY_FIRST && nyScoped<NY_FIRST_MILESTONE){
      console.log(JSON.stringify({event:"ny_priority_hold",nyScoped,nyTarget:NY_FIRST_MILESTONE,scoped,queue,pausedNational,cursor}));
      await new Promise(r=>setTimeout(r,LOOP_MS));
      continue;
    }

    const nyPriorityLen=await redis.lLen(NY_PRIORITY_QUEUE);
    if(!ENFORCE_NY_FIRST && nyPriorityLen>0){
      const parkedNy=await parkNySurplus();
      console.log(JSON.stringify({event:"ny_surplus_parked",nyScoped,nyTarget:NY_FIRST_MILESTONE,...parkedNy}));
    }

    if(pausedNational>0){
      const capacity=Math.max(0,QUEUE_HIGH_WATER-queue);
      if(capacity>0){
        const resumed=await resumePausedNational(capacity);
        console.log(JSON.stringify({
          event:"national_resume_parked",
          nyScoped,
          nyTarget:NY_FIRST_MILESTONE,
          queue_before:queue,
          capacity,
          ...resumed
        }));
      }else{
        console.log(JSON.stringify({event:"national_resume_backpressure",nyScoped,queue,pausedNational}));
      }
      await new Promise(r=>setTimeout(r,LOOP_MS));
      continue;
    }

    if(scoped>=TARGET_TOTAL){
      console.log(JSON.stringify({event:"target_reached",scoped,queue,cursor}));
      await new Promise(r=>setTimeout(r,LOOP_MS));
      continue;
    }

    if(cursor>=areas.length && scoped<TARGET_TOTAL){
      coveragePass++;
      cursor=0;
      await redis.hSet(CONTROLLER_KEY,{cursor:"0",coverage_pass:String(coveragePass)});
      console.log(JSON.stringify({event:"coverage_pass_advanced",coveragePass,scoped,area_count:areas.length}));
    }

    if(queue>=QUEUE_HIGH_WATER){
      console.log(JSON.stringify({event:"backpressure",scoped,queue,cursor}));
      await new Promise(r=>setTimeout(r,LOOP_MS));
      continue;
    }

    let seeded=0, checked=0;
    while(seeded<SEED_BATCH_SIZE && cursor<areas.length && queue+seeded<QUEUE_HIGH_WATER){
      const area=areas[cursor++];
      checked++;
      if(await seedOne(area)) seeded++;
      await redis.hSet(CONTROLLER_KEY,"cursor",String(cursor));
    }

    console.log(JSON.stringify({
      event:"seed_cycle",
      scoped,
      queue_before:queue,
      checked,
      seeded,
      cursor,
      coveragePass,
      partition_state:String(areas[Math.max(0,cursor-1)]?.partition_state||""),
      partition_city:String(areas[Math.max(0,cursor-1)]?.partition_city||""),
      area_count:areas.length
    }));

    if(cursor>=areas.length){
      console.log(JSON.stringify({event:"coverage_pass_complete",scoped,cursor,coveragePass,area_count:areas.length}));
    }
  }catch(error){
    console.error("Controller loop error",error);
  }
  await new Promise(r=>setTimeout(r,LOOP_MS));
}

// strict classifier controller refresh 2026-09-10
