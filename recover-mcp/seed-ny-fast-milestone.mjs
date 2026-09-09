import { createClient } from "redis";
import { randomUUID } from "node:crypto";
import { claimCoverage } from "./acquisition-coverage.mjs";

const REDIS_URL=process.env.ACQUISITION_REDIS_URL||"";
if(!REDIS_URL) throw new Error("ACQUISITION_REDIS_URL required");
const TTL=Number(process.env.ACQUISITION_TTL_SECONDS||604800);
const ZIP_SOURCE_URL=process.env.US_ZIP_SOURCE_URL||
  "https://raw.githubusercontent.com/ReadyAPIs-com/curated-us-zips/main/data/us-zips.csv";
const BATCH_ID=process.env.NY_FAST_BATCH_ID||"ny-home-comfort-fast-1000-2026-09-09";
const ZIP_LIMIT=Number(process.env.NY_FAST_ZIP_LIMIT||250);
const TARGET_PER_AREA=Number(process.env.NY_FAST_TARGET_PER_AREA||12);
const DEPTH=Number(process.env.NY_FAST_DEPTH||15);
const MAX_ROUNDS=Number(process.env.NY_FAST_MAX_ROUNDS||4);

function parseCsvLine(line){
  const out=[]; let cell="",quoted=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(quoted){
      if(ch==='"'&&line[i+1]==='"'){cell+='"';i++;}
      else if(ch==='"') quoted=false;
      else cell+=ch;
    }else{
      if(ch==='"') quoted=true;
      else if(ch===','){out.push(cell);cell="";}
      else cell+=ch;
    }
  }
  out.push(cell); return out;
}

async function nyZipAreas(){
  const res=await fetch(ZIP_SOURCE_URL,{headers:{"user-agent":"Recover-Scrape/1.0"}});
  if(!res.ok) throw new Error("zip source failed "+res.status);
  const lines=(await res.text()).split(/\r?\n/).filter(Boolean);
  const header=parseCsvLine(lines[0]).map(x=>x.trim());
  const idx=Object.fromEntries(header.map((x,i)=>[x,i]));
  const rows=[];
  for(const line of lines.slice(1)){
    const r=parseCsvLine(line);
    const state=String(r[idx.state]||"").trim().toUpperCase();
    if(state!=="NY") continue;
    const zip=String(r[idx.zip_code]||"").trim().padStart(5,"0");
    const city=String(r[idx.city]||"").trim();
    const population=Number(String(r[idx.population]||"0").replace(/[^0-9.-]/g,""))||0;
    if(!/^\d{5}$/.test(zip)||!city) continue;
    rows.push({zip,city,population,location:`${zip} ${city}, NY`});
  }
  rows.sort((a,b)=>b.population-a.population||a.zip.localeCompare(b.zip));
  return rows.slice(0,ZIP_LIMIT);
}

const redis=createClient({url:REDIS_URL});
await redis.connect();

// Park old nationwide queued work. Preserve all job state so it can be resumed after NY 1,000.
const normal="recover:acquisition:queue";
const paused="recover:acquisition:queue:paused-national";
const priority="recover:acquisition:queue:ny-priority";
const queue=await redis.lRange(normal,0,-1);
const keepNy=[]; const park=[]; const seen=new Set();
for(const id of queue){
  if(seen.has(id)) continue; seen.add(id);
  const raw=await redis.get("recover:acq:"+id); if(!raw) continue;
  let job; try{job=JSON.parse(raw)}catch{continue}
  if(job.status!=="queued") continue;
  if(/\bny\b|new york/i.test(String(job.location||""))) keepNy.push(id);
  else park.push(id);
}
await redis.del(normal);
for(let i=keepNy.length-1;i>=0;i--) await redis.lPush(normal,keepNy[i]);
for(const id of park){
  if(await redis.lPos(paused,id)===null) await redis.rPush(paused,id);
}

const areas=await nyZipAreas();
const now=new Date().toISOString();
let seeded=0, covered=0;
for(const area of areas){
  const id=randomUUID();
  const job={
    id,batch_id:BATCH_ID,industry:"HOME_COMFORT_TRADES",location:area.location,
    target:TARGET_PER_AREA,min_score:30,
    require_phone:false,require_email:false,require_contact:true,
    require_no_website:true,include_no_website:true,
    max_rounds:MAX_ROUNDS,depth:DEPTH,
    status:"queued",phase:"queued",round:0,rounds_completed:0,
    raw_count:0,unique_count:0,qualified_count:0,stored_count:0,
    maps_jobs:[],source:"ny_fast_zip_milestone",source_zip:area.zip,
    source_population:area.population,created_at:now,updated_at:now
  };
  const claim=await claimCoverage(redis,job,{source:"ny_fast_zip_milestone",source_zip:area.zip});
  if(!claim.claimed){covered++;continue;}
  await redis.set("recover:acq:"+id,JSON.stringify(job),{EX:TTL});
  await redis.sAdd("recover:acq:index",id);
  await redis.sAdd("recover:batch:"+BATCH_ID+":jobs",id);
  await redis.expire("recover:batch:"+BATCH_ID+":jobs",TTL);
  await redis.lPush(priority,id);
  seeded++;
}
await redis.set("recover:batch:"+BATCH_ID+":meta",JSON.stringify({
  batch_id:BATCH_ID,industry:"HOME_COMFORT_TRADES",region:"New York State",
  first_milestone:1000,rule:"no_website AND (phone OR email)",
  zip_limit:ZIP_LIMIT,target_per_area:TARGET_PER_AREA,depth:DEPTH,max_rounds:MAX_ROUNDS,
  seeded,covered,created_at:now
}),{EX:TTL});

console.log(JSON.stringify({
  ok:true,batch_id:BATCH_ID,
  national_parked:park.length,ny_normal_kept:keepNy.length,
  ny_zip_areas:areas.length,seeded,covered,
  priority_len:await redis.lLen(priority),
  normal_queue_len:await redis.lLen(normal),
  paused_national_len:await redis.lLen(paused)
}));
await redis.quit();

// deployment trigger: run-fast-ny-milestone
