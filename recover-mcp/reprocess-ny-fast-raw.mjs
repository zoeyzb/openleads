import { createClient } from "redis";

const REDIS_URL=process.env.ACQUISITION_REDIS_URL||process.env.REDIS_URL||"";
if(!REDIS_URL) throw new Error("ACQUISITION_REDIS_URL is required");
const redis=createClient({url:REDIS_URL});
redis.on("error",e=>console.error("Redis error",e));

function text(v=""){return String(v).toLowerCase().replace(/[^a-z0-9]+/g," ").trim();}
function phone(v=""){return String(v).replace(/\D/g,"").slice(-10);}
function emails(v){
  const xs=Array.isArray(v)?v:String(v||"").split(/[;,\s]+/);
  return [...new Set(xs.map(x=>String(x).trim().toLowerCase()).filter(x=>/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))];
}
function isNy(lead){
  const address=String(lead.address||lead.full_address||lead.formatted_address||"").toLowerCase();
  const region=String(lead.region||lead.state||lead.state_code||lead.province||"").toLowerCase().trim();
  const city=String(lead.city||lead.locality||lead.town||"").toLowerCase().trim();
  const other=/,\s*(al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy)\b/i.test(address);
  if(other) return false;
  if(/^(ny|new york)$/.test(region)) return true;
  if(/,\s*ny\b|new york\b/i.test(address)) return true;
  return /new york/.test(city) && !region;
}
function trade(lead){
  const category=text(lead.category||lead.industry||"");
  const name=text(lead.title||lead.name||"");
  const desc=text(lead.descriptions||lead.description||"");
  const hay=[category,name,desc].filter(Boolean).join(" ");
  if(/restaurant|cafe|food|retail|grocery|hotel|motel|lawyer|attorney|dentist|doctor|medical|insurance|real estate|auto repair|car dealer|beauty|salon|school|church|marketing|software|computer repair/.test(category)) return false;
  if(/hvac|heating contractor|air conditioning contractor|air conditioning repair|heating repair|cooling contractor|furnace repair|furnace contractor|boiler repair|boiler contractor|duct cleaning|air duct|ventilation|refrigeration contractor|plumbing contractor|plumber|plumbing service/.test(hay)) return true;
  if(/mechanical contractor|mechanical service|heating equipment supplier|air conditioning equipment supplier/.test(category)){
    return /hvac|heating|cooling|air conditioning|furnace|boiler|duct|ventilation|refrigeration|plumb/.test(name+" "+desc);
  }
  return false;
}
function identity(lead){
  if(lead.place_id) return "place:"+String(lead.place_id).trim();
  if(lead.cid) return "cid:"+String(lead.cid).trim();
  const p=phone(lead.phone||"");
  if(p) return "phone:"+p;
  return "nameaddr:"+text((lead.name||lead.title||"")+"|"+(lead.address||""));
}
function compact(lead,job){
  const es=emails(lead.emails||lead.email||"");
  let score=0;
  if(/hvac|heating|air conditioning|plumb|furnace|boiler|duct|ventilation|refrigeration/.test(text(lead.category||lead.industry||""))) score+=15;
  score+=20;
  if(lead.phone) score+=10;
  if(es.length) score+=10;
  if(Number(lead.review_count||lead.reviews||0)>=20) score+=10;
  if(Number(lead.review_rating||lead.rating||0)>=4.2) score+=5;
  return {
    name:lead.name||lead.title||"",
    category:lead.category||lead.industry||"",
    address:lead.address||lead.full_address||lead.formatted_address||"",
    city:lead.city||lead.locality||"",
    region:lead.region||lead.state||lead.state_code||"",
    website:"",
    phone:lead.phone||"",
    emails:es,
    owner_name:"",
    google_maps_url:lead.link||lead.google_maps_url||"",
    place_id:lead.place_id||"",
    review_count:Number(lead.review_count||lead.reviews||0),
    review_rating:Number(lead.review_rating||lead.rating||0),
    qualification:{score:Math.min(100,score),tier:score>=70?"strong":score>=50?"maybe":score>=30?"weak":"reject",reasons:[{points:20,reason:"no website"}]},
    acquisition_id:job.id,
    acquisition_location:job.location||"",
    industry:job.industry||"",
    campaign_scope:"recover:leadstore:ny-home-comfort",
    persisted_at:new Date().toISOString()
  };
}

await redis.connect();
const beforeQualified=await redis.hLen("recover:leadstore:qualified");
const beforeNy=await redis.sCard("recover:leadstore:ny-home-comfort");
const ids=await redis.sMembers("recover:acq:index");
const stats={jobsScanned:0,rawRows:0,ny:0,trade:0,noWebsite:0,contactable:0,persistedAttempts:0,uniqueKeys:new Set(),reject:{notNy:0,notTrade:0,hasWebsite:0,noContact:0}};
const batch=[];
for(const id of ids){
  const rawJob=await redis.get("recover:acq:"+id);
  if(!rawJob) continue;
  let job; try{job=JSON.parse(rawJob);}catch{continue;}
  // Deep recovery: scan every historical acquisition raw list, then strictly
  // keep only New York + home-comfort + no-website + contactable rows.
  stats.jobsScanned++;
  const rows=await redis.lRange("recover:acq:"+id+":raw",0,-1);
  for(const s of rows){
    let lead; try{lead=JSON.parse(s);}catch{continue;}
    stats.rawRows++;
    if(!isNy(lead)){stats.reject.notNy++;continue;} stats.ny++;
    if(!trade(lead)){stats.reject.notTrade++;continue;} stats.trade++;
    if(String(lead.website||lead.domain||"").trim()){stats.reject.hasWebsite++;continue;} stats.noWebsite++;
    const es=emails(lead.emails||lead.email||"");
    if(!String(lead.phone||"").trim() && !es.length){stats.reject.noContact++;continue;} stats.contactable++;
    const key=identity(lead);
    if(!key) continue;
    const row=compact(lead,job);
    batch.push([key,JSON.stringify(row)]);
    stats.uniqueKeys.add(key);
    stats.persistedAttempts++;
    if(batch.length>=250){
      const tx=redis.multi();
      for(const [k,v] of batch){tx.hSet("recover:leadstore:qualified",k,v);tx.sAdd("recover:leadstore:ny-home-comfort",k);}
      await tx.exec(); batch.length=0;
    }
  }
}
if(batch.length){
  const tx=redis.multi();
  for(const [k,v] of batch){tx.hSet("recover:leadstore:qualified",k,v);tx.sAdd("recover:leadstore:ny-home-comfort",k);}
  await tx.exec();
}
const afterQualified=await redis.hLen("recover:leadstore:qualified");
const afterNy=await redis.sCard("recover:leadstore:ny-home-comfort");
console.log(JSON.stringify({
  event:"ny_all_history_raw_reprocess_complete",
  beforeQualified,afterQualified,qualifiedDelta:afterQualified-beforeQualified,
  beforeNy,afterNy,nyDelta:afterNy-beforeNy,
  jobsScanned:stats.jobsScanned,rawRows:stats.rawRows,nyRows:stats.ny,tradeRows:stats.trade,
  noWebsiteRows:stats.noWebsite,contactableRows:stats.contactable,
  uniqueCandidateKeys:stats.uniqueKeys.size,reject:stats.reject
},null,2));
await redis.quit();

// deployment trigger: force Railway branch rebuild
