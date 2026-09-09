import { createClient } from "redis";
import { randomUUID } from "node:crypto";
import { claimCoverage, campaignLeadSetKey, qualificationProfile } from "./acquisition-coverage.mjs";

const REDIS_URL=process.env.ACQUISITION_REDIS_URL||"";
if(!REDIS_URL) throw new Error("ACQUISITION_REDIS_URL required");

const ZIP_SOURCE_URL=process.env.US_ZIP_SOURCE_URL||
  "https://raw.githubusercontent.com/ReadyAPIs-com/curated-us-zips/main/data/us-zips.csv";
const TARGET_TOTAL=Number(process.env.US_HVAC_TARGET_TOTAL||100000);
const NY_FIRST_MILESTONE=Number(process.env.NY_HOME_COMFORT_FIRST_MILESTONE||1000);
const NY_SCOPE_SET="recover:leadstore:ny-home-comfort";
const FIRST_MILESTONE=Number(process.env.US_HVAC_FIRST_MILESTONE||1000);
const QUEUE_HIGH_WATER=Number(process.env.US_HVAC_QUEUE_HIGH_WATER||96);
const SEED_BATCH_SIZE=Number(process.env.US_HVAC_SEED_BATCH_SIZE||36);
const TARGET_PER_AREA=Number(process.env.US_HVAC_ZIP_TARGET_PER_AREA||25);
const DEPTH=Number(process.env.US_HVAC_ZIP_DEPTH||20);
const MAX_ROUNDS=Number(process.env.US_HVAC_ZIP_MAX_ROUNDS||3);
const LOOP_MS=Number(process.env.US_HVAC_CONTROLLER_LOOP_MS||15000);
const TTL=Number(process.env.ACQUISITION_TTL_SECONDS||604800);
const CONTROLLER_KEY="recover:controller:us-hvac-zip:v1";
const BATCH_ID=process.env.US_HVAC_BATCH_ID||"us-hvac-zip-100k-2026-09-08";

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
  const text=String([lead.industry,lead.category,lead.name,lead.title].filter(Boolean).join(" ")).toLowerCase();
  return /hvac|heating|cooling|air conditioning|furnace|boiler|duct|ventilation|refrigeration|plumb/.test(text);
}
async function bootstrapNyScope(redis){
  const existing=await redis.sCard(NY_SCOPE_SET);
  if(existing>0) return existing;
  const all=await redis.hGetAll("recover:leadstore:qualified");
  const ids=[];
  for(const [identity,raw] of Object.entries(all)){
    let lead; try{lead=JSON.parse(raw)}catch{continue}
    if(String(lead.website||"").trim()) continue;
    const hasContact=String(lead.phone||"").trim() || (Array.isArray(lead.emails)&&lead.emails.length) || String(lead.email||"").trim();
    if(!hasContact) continue;
    if(!isNyLocation(lead.acquisition_location||lead.region||lead.state||lead.address||"")) continue;
    if(!isHomeComfortLead(lead)) continue;
    ids.push(identity);
  }
  if(ids.length) {
    for(let i=0;i<ids.length;i+=500) await redis.sAdd(NY_SCOPE_SET,ids.slice(i,i+500));
  }
  const total=await redis.sCard(NY_SCOPE_SET);
  console.log(JSON.stringify({event:"ny_scope_bootstrap",total}));
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
  const all=await redis.hGetAll("recover:leadstore:qualified");
  const expectedProfile=qualificationProfile(profileJob);
  const jobCache=new Map();
  const emailList=v=>{
    const arr=Array.isArray(v)?v:String(v||"").split(/[;,\s]+/);
    return arr.map(x=>String(x).trim().toLowerCase()).filter(x=>/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
  };
  let added=0;
  for(const [identity,raw] of Object.entries(all)){
    let lead; try{lead=JSON.parse(raw)}catch{continue}
    if(String(lead.website||"").trim()) continue;
    if(!String(lead.phone||"").trim() && !emailList(lead.emails||lead.email||"").length) continue;

    let matches=lead.campaign_scope===scopeSet;
    const acquisitionId=lead.acquisition_id||"";
    if(!matches && acquisitionId){
      let job=jobCache.get(acquisitionId);
      if(job===undefined){
        const jraw=await redis.get("recover:acq:"+acquisitionId);
        try{job=jraw?JSON.parse(jraw):null}catch{job=null}
        jobCache.set(acquisitionId,job);
      }
      if(job && String(job.industry||"").toLowerCase()==="hvac" && qualificationProfile(job)===expectedProfile) matches=true;
    }
    if(!matches){
      const hvacText=String(lead.industry||lead.category||"").toLowerCase();
      if(/hvac|heating|air conditioning|cooling|mechanical|refrigeration/.test(hvacText)) matches=true;
    }
    if(matches) added+=await redis.sAdd(scopeSet,identity);
  }
  const total=await redis.sCard(scopeSet);
  console.log(JSON.stringify({event:"scope_bootstrap",added,total}));
  return total;
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

  out.sort((a,b)=>b.population-a.population || a.zip.localeCompare(b.zip));
  if(!out.length) throw new Error("zip source parsed zero areas");
  return out;
}

const redis=createClient({url:REDIS_URL});
redis.on("error",e=>console.error("Redis error",e));
await redis.connect();

const areas=await fetchZipAreas();
const scopeSet=campaignLeadSetKey(profileJob);
await bootstrapScopedLeads(redis,scopeSet);
await bootstrapNyScope(redis);
let cursor=Number(await redis.hGet(CONTROLLER_KEY,"cursor")||0);
console.log("US HVAC ZIP controller started",JSON.stringify({
  areas:areas.length,target:TARGET_TOTAL,scopeSet,cursor,
  targetPerArea:TARGET_PER_AREA,maxRounds:MAX_ROUNDS,depth:DEPTH,
  queueHighWater:QUEUE_HIGH_WATER
}));

async function seedOne(area){
  const id=randomUUID(), now=new Date().toISOString();
  const job={
    id,
    batch_id:BATCH_ID,
    industry:"HVAC",
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
    source:"us_zip_controller",
    source_zip:area.zip,
    source_population:area.population,
    created_at:now,
    updated_at:now
  };

  const claim=await claimCoverage(redis,job,{
    source:"us_zip_controller",
    source_zip:area.zip,
    source_population:area.population
  });
  if(!claim.claimed) return false;

  await redis.set("recover:acq:"+id,JSON.stringify(job),{EX:TTL});
  await redis.sAdd("recover:acq:index",id);
  await redis.sAdd("recover:batch:"+BATCH_ID+":jobs",id);
  await redis.expire("recover:batch:"+BATCH_ID+":jobs",TTL);
  const pos=await redis.lPos("recover:acquisition:queue",id);
  if(pos===null) await redis.lPush("recover:acquisition:queue",id);
  return true;
}

while(true){
  try{
    const scoped=await redis.sCard(scopeSet);
    const nyScoped=await redis.sCard(NY_SCOPE_SET);
    const queue=await redis.lLen("recover:acquisition:queue");

    await redis.hSet(CONTROLLER_KEY,{
      scoped_count:String(scoped),
      queue_len:String(queue),
      cursor:String(cursor),
      area_count:String(areas.length),
      updated_at:new Date().toISOString(),
      milestone_1000:scoped>=FIRST_MILESTONE?"reached":"pending",
      ny_priority_count:String(nyScoped),
      ny_priority_milestone:nyScoped>=NY_FIRST_MILESTONE?"reached":"pending",
      target_100k:scoped>=TARGET_TOTAL?"reached":"pending"
    });

    if(nyScoped<NY_FIRST_MILESTONE){
      console.log(JSON.stringify({event:"ny_priority_hold",nyScoped,nyTarget:NY_FIRST_MILESTONE,scoped,queue,cursor}));
      await new Promise(r=>setTimeout(r,LOOP_MS));
      continue;
    }

    if(scoped>=TARGET_TOTAL){
      console.log(JSON.stringify({event:"target_reached",scoped,queue,cursor}));
      await new Promise(r=>setTimeout(r,LOOP_MS));
      continue;
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
      area_count:areas.length
    }));

    if(cursor>=areas.length){
      console.log(JSON.stringify({event:"source_exhausted",scoped,cursor,area_count:areas.length}));
    }
  }catch(error){
    console.error("Controller loop error",error);
  }
  await new Promise(r=>setTimeout(r,LOOP_MS));
}
