import { createClient } from "redis";
import { randomUUID } from "node:crypto";
import { claimCoverage, campaignLeadSetKey } from "./acquisition-coverage.mjs";

const REDIS_URL=process.env.ACQUISITION_REDIS_URL||"";
if(!REDIS_URL) throw new Error("ACQUISITION_REDIS_URL required");

const CITY_SOURCE_URL=process.env.US_CITY_SOURCE_URL||
  "https://gist.githubusercontent.com/Miserlou/11500b2345d3fe850c92/raw/e36859a9eef58c231865429ade1c142a2b75f16e/gistfile1.txt";
const TARGET_TOTAL=Number(process.env.US_HVAC_TARGET_TOTAL||100000);
const FIRST_MILESTONE=Number(process.env.US_HVAC_FIRST_MILESTONE||1000);
const QUEUE_HIGH_WATER=Number(process.env.US_HVAC_QUEUE_HIGH_WATER||48);
const SEED_BATCH_SIZE=Number(process.env.US_HVAC_SEED_BATCH_SIZE||18);
const TARGET_PER_AREA=Number(process.env.US_HVAC_TARGET_PER_AREA||100);
const DEPTH=Number(process.env.US_HVAC_DEPTH||25);
const MAX_ROUNDS=Number(process.env.US_HVAC_MAX_ROUNDS||20);
const LOOP_MS=Number(process.env.US_HVAC_CONTROLLER_LOOP_MS||30000);
const TTL=Number(process.env.ACQUISITION_TTL_SECONDS||604800);
const CONTROLLER_KEY=process.env.US_HVAC_CONTROLLER_KEY||"recover:controller:us-hvac-no-website:v1";
const BATCH_ID=process.env.US_HVAC_BATCH_ID||"us-hvac-no-website-100k-2026-09-07";

const stateCodes={
 "Alabama":"AL","Alaska":"AK","Arizona":"AZ","Arkansas":"AR","California":"CA","Colorado":"CO",
 "Connecticut":"CT","Delaware":"DE","District of Columbia":"DC","Florida":"FL","Georgia":"GA",
 "Hawaii":"HI","Idaho":"ID","Illinois":"IL","Indiana":"IN","Iowa":"IA","Kansas":"KS","Kentucky":"KY",
 "Louisiana":"LA","Maine":"ME","Maryland":"MD","Massachusetts":"MA","Michigan":"MI","Minnesota":"MN",
 "Mississippi":"MS","Missouri":"MO","Montana":"MT","Nebraska":"NE","Nevada":"NV","New Hampshire":"NH",
 "New Jersey":"NJ","New Mexico":"NM","New York":"NY","North Carolina":"NC","North Dakota":"ND","Ohio":"OH",
 "Oklahoma":"OK","Oregon":"OR","Pennsylvania":"PA","Rhode Island":"RI","South Carolina":"SC",
 "South Dakota":"SD","Tennessee":"TN","Texas":"TX","Utah":"UT","Vermont":"VT","Virginia":"VA",
 "Washington":"WA","West Virginia":"WV","Wisconsin":"WI","Wyoming":"WY"
};

const profileJob={
  industry:"HVAC",
  require_no_website:true,
  require_contact:true,
  require_phone:false,
  require_email:false,
  include_no_website:true,
  min_score:30
};

async function fetchCities(){
  const res=await fetch(CITY_SOURCE_URL,{headers:{"user-agent":"Recover-Scrape/1.0"}});
  if(!res.ok) throw new Error(`city source failed ${res.status}`);
  const text=await res.text();
  const out=[];
  const seen=new Set();
  for(const raw of text.split(/\r?\n/)){
    const line=raw.trim();
    const m=line.match(/^(\d+),([^,]+),([^,]+),(\d+),/);
    if(!m) continue;
    const rank=Number(m[1]), city=m[2].trim(), stateName=m[3].trim();
    const code=stateCodes[stateName]||stateName;
    const location=`${city}, ${code}`;
    const key=location.toLowerCase();
    if(seen.has(key)) continue;
    seen.add(key);
    out.push({rank,city,state:code,location,population:Number(m[4])});
  }
  out.sort((a,b)=>a.rank-b.rank);
  if(!out.length) throw new Error("city source parsed zero cities");
  return out;
}

const redis=createClient({url:REDIS_URL});
redis.on("error",e=>console.error("Redis error",e));
await redis.connect();

const cities=await fetchCities();
const scopeSet=campaignLeadSetKey(profileJob);
console.log("US HVAC controller started","cities",cities.length,"scope",scopeSet,"target",TARGET_TOTAL);

let cursor=Number(await redis.hGet(CONTROLLER_KEY,"cursor")||0);
let sourceExhausted=false;

async function seedOne(area){
  const id=randomUUID();
  const now=new Date().toISOString();
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
    source:"us_city_controller",
    source_rank:area.rank,
    source_population:area.population,
    created_at:now,
    updated_at:now
  };

  const claim=await claimCoverage(redis,job,{source:"us_city_controller",source_rank:area.rank});
  if(!claim.claimed) return {seeded:false,reason:"covered",existing:claim.existing};

  await redis.set("recover:acq:"+id,JSON.stringify(job),{EX:TTL});
  await redis.sAdd("recover:acq:index",id);
  await redis.sAdd("recover:batch:"+BATCH_ID+":jobs",id);
  await redis.expire("recover:batch:"+BATCH_ID+":jobs",TTL);
  await redis.lPush("recover:acquisition:queue",id);
  return {seeded:true,id};
}

while(true){
  try{
    const scoped=await redis.sCard(scopeSet);
    const queue=await redis.lLen("recover:acquisition:queue");
    await redis.hSet(CONTROLLER_KEY,{
      scoped_count:String(scoped),
      queue_len:String(queue),
      cursor:String(cursor),
      city_count:String(cities.length),
      updated_at:new Date().toISOString(),
      milestone_1000:scoped>=FIRST_MILESTONE?"reached":"pending",
      target_100k:scoped>=TARGET_TOTAL?"reached":"pending"
    });

    if(scoped>=TARGET_TOTAL){
      console.log(JSON.stringify({event:"target_reached",scoped,target:TARGET_TOTAL,queue,cursor}));
      await new Promise(r=>setTimeout(r,LOOP_MS));
      continue;
    }

    if(queue>=QUEUE_HIGH_WATER){
      console.log(JSON.stringify({event:"backpressure",scoped,queue,cursor}));
      await new Promise(r=>setTimeout(r,LOOP_MS));
      continue;
    }

    let seeded=0,checked=0;
    while(seeded<SEED_BATCH_SIZE && cursor<cities.length && (queue+seeded)<QUEUE_HIGH_WATER){
      const area=cities[cursor++];
      checked++;
      const result=await seedOne(area);
      if(result.seeded) seeded++;
      await redis.hSet(CONTROLLER_KEY,"cursor",String(cursor));
    }

    if(cursor>=cities.length){
      sourceExhausted=true;
      await redis.hSet(CONTROLLER_KEY,{
        source_exhausted:"true",
        source_exhausted_at:new Date().toISOString()
      });
    }

    console.log(JSON.stringify({
      event:"seed_cycle",
      scoped,
      queue_before:queue,
      checked,
      seeded,
      cursor,
      city_count:cities.length,
      source_exhausted:sourceExhausted,
      milestone_1000:scoped>=FIRST_MILESTONE
    }));
  }catch(error){
    console.error("Controller loop error",error);
  }
  await new Promise(r=>setTimeout(r,LOOP_MS));
}
