import { createClient } from "redis";
import { randomUUID } from "node:crypto";
import { claimCoverage } from "./acquisition-coverage.mjs";

const REDIS_URL=process.env.ACQUISITION_REDIS_URL||process.env.REDIS_URL||"";
if(!REDIS_URL) throw new Error("ACQUISITION_REDIS_URL required");
const TTL=Number(process.env.ACQUISITION_TTL_SECONDS||604800);
const ZIP_SOURCE_URL=process.env.US_ZIP_SOURCE_URL||
  "https://raw.githubusercontent.com/ReadyAPIs-com/curated-us-zips/main/data/us-zips.csv";
const BATCH_ID="ny-home-comfort-fast-pass2-2026-09-09";
const COVERAGE_PASS="pass2";
const ZIP_LIMIT=600;

function parseCsvLine(line){
  const out=[]; let cell="",quoted=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(quoted){
      if(ch==='"'&&line[i+1]==='"'){cell+='"';i++;}
      else if(ch==='"') quoted=false;
      else cell+=ch;
    } else {
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
    if(String(r[idx.state]||"").trim().toUpperCase()!=="NY") continue;
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

const priority="recover:acquisition:queue:ny-priority";
const areas=await nyZipAreas();
const now=new Date().toISOString();
let seeded=0,covered=0;

// Push in reverse population order onto the right so BRPOP consumes highest-population ZIPs first.
for(let i=areas.length-1;i>=0;i--){
  const area=areas[i];
  const id=randomUUID();
  const job={
    id,
    batch_id:BATCH_ID,
    coverage_pass:COVERAGE_PASS,
    industry:"HOME_COMFORT_TRADES",
    location:area.location,
    target:20,
    min_score:30,
    require_phone:false,
    require_email:false,
    require_contact:true,
    require_no_website:true,
    include_no_website:true,
    max_rounds:1,
    depth:6,
    status:"queued",
    phase:"queued",
    round:0,
    rounds_completed:0,
    raw_count:0,
    unique_count:0,
    qualified_count:0,
    stored_count:0,
    maps_jobs:[],
    source:"ny_fast_zip_milestone_pass2",
    source_zip:area.zip,
    source_population:area.population,
    created_at:now,
    updated_at:now
  };
  const claim=await claimCoverage(redis,job,{
    source:"ny_fast_zip_milestone_pass2",
    source_zip:area.zip,
    coverage_pass:COVERAGE_PASS
  });
  if(!claim.claimed){covered++;continue;}
  await redis.set("recover:acq:"+id,JSON.stringify(job),{EX:TTL});
  await redis.sAdd("recover:acq:index",id);
  await redis.sAdd("recover:batch:"+BATCH_ID+":jobs",id);
  await redis.expire("recover:batch:"+BATCH_ID+":jobs",TTL);
  // Right side is consumed first by BRPOP; reverse loop preserves highest-pop first.
  await redis.rPush(priority,id);
  seeded++;
}

await redis.set("recover:batch:"+BATCH_ID+":meta",JSON.stringify({
  batch_id:BATCH_ID,
  coverage_pass:COVERAGE_PASS,
  industry:"HOME_COMFORT_TRADES",
  region:"New York State",
  first_milestone:1000,
  rule:"no_website AND (phone OR email)",
  zip_limit:ZIP_LIMIT,
  target_per_area:20,
  depth:6,
  max_rounds:1,
  bundled_trade_intents:3,
  seeded,
  covered,
  created_at:now
}),{EX:TTL});

console.log(JSON.stringify({
  event:"ny_fast_pass2_seeded",
  batch_id:BATCH_ID,
  coverage_pass:COVERAGE_PASS,
  ny_zip_areas:areas.length,
  seeded,
  covered,
  priority_len:await redis.lLen(priority),
  ny_scope:await redis.sCard("recover:leadstore:ny-home-comfort")
},null,2));
await redis.quit();
