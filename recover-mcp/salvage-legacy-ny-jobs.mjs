import { createClient } from "redis";
import { matchesRequestedLocation, upsertQualifiedLeads } from "./acquisition-persistence.mjs";

const redis=createClient({url:process.env.ACQUISITION_REDIS_URL||""});
await redis.connect();
const JOB_TTL=Number(process.env.ACQUISITION_TTL_SECONDS||604800);

const JOBS=[
  "b7a7858d-32a6-46c9-823c-0e477f938955",
  "434a1078-628b-48b0-b644-29a151bbf217",
  "99126613-c5ad-49c7-9fa5-1e92fd70e14b",
  "0861b272-d805-4af2-a084-71169153c7f8",
  "b28d3596-e31f-47ce-8342-040c3895ad67",
  "df431879-e411-4536-bf87-a154ec180e84",
  "257d68a2-1e52-4d7c-8256-2c346f981e2c",
  "2b104e7d-0c38-483f-8187-6852e79c7439"
];

function normalizeText(v=""){return String(v).toLowerCase().replace(/[^a-z0-9]+/g," ").trim();}
function normalizeEmails(value){
  const values=Array.isArray(value)?value:String(value||"").split(/[;,\s]+/);
  return [...new Set(values.map(x=>String(x).trim().toLowerCase()).filter(x=>/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))];
}
function matchesRequestedIndustry(lead,industry){
  const target=normalizeText(industry||"");
  const hay=normalizeText((lead.category||"")+" "+(lead.title||lead.name||"")+" "+(lead.descriptions||""));
  if(!target) return true;
  if(/hvac|heating|air conditioning|cooling/.test(target)) return /hvac|heating|cooling|air conditioning|mechanical contractor/.test(hay);
  return true;
}
function scoreLead(lead){
  let score=0;
  const category=normalizeText(lead.category||lead.industry||"");
  if(/hvac|heating|air conditioning|plumb|roof|electric/.test(category)) score+=15;
  if(!lead.website) score+=20;
  const reviews=Number(lead.review_count||lead.reviews||0);
  if(reviews>=20) score+=10;
  if(Number(lead.review_rating||lead.rating||0)>=4.2) score+=5;
  if(lead.phone) score+=10;
  if(normalizeEmails(lead.emails||lead.email||"").length) score+=10;
  return Math.min(100,score);
}
function compactLead(lead){
  return {
    name:lead.name||lead.title||"",
    category:lead.category||lead.industry||"",
    address:lead.address||"",
    city:lead.city||lead.locality||"",
    region:lead.region||lead.state||lead.state_code||"",
    website:lead.website||"",
    phone:lead.phone||"",
    emails:normalizeEmails(lead.emails||lead.email||""),
    google_maps_url:lead.link||lead.google_maps_url||"",
    place_id:lead.place_id||"",
    review_count:Number(lead.review_count||lead.reviews||0),
    review_rating:Number(lead.review_rating||lead.rating||0),
    qualification:{score:scoreLead(lead),tier:"legacy_salvage"}
  };
}
async function loadList(key){
  const rows=await redis.lRange(key,0,-1);
  return rows.map(x=>{try{return JSON.parse(x)}catch{return null}}).filter(Boolean);
}
async function replaceList(key,values){
  await redis.del(key);
  for(let i=0;i<values.length;i+=200){
    const chunk=values.slice(i,i+200).map(x=>JSON.stringify(x));
    if(chunk.length) await redis.rPush(key,chunk);
  }
  await redis.expire(key,JOB_TTL);
}

const summary=[];
for(const id of JOBS){
  const rawJob=await redis.get("recover:acq:"+id);
  if(!rawJob){summary.push({id,error:"missing_job"});continue;}
  const job=JSON.parse(rawJob);
  const raw=await loadList("recover:acq:"+id+":raw");
  let qualified=raw
    .filter(x=>matchesRequestedLocation(x,job.location))
    .filter(x=>matchesRequestedIndustry(x,job.industry))
    .filter(x=>!x.website)
    .filter(x=>!!x.phone||normalizeEmails(x.emails||x.email||"").length>0)
    .map(x=>({...x,qualification:{score:scoreLead(x),tier:"legacy_salvage"}}))
    .filter(x=>x.qualification.score>=Number(job.min_score||0))
    .map(compactLead);

  const existing=await loadList("recover:acq:"+id+":results");
  const persisted=upsertQualifiedLeads(existing,qualified);
  await replaceList("recover:acq:"+id+":results",persisted);

  job.stored_count=persisted.length;
  job.salvaged_at=new Date().toISOString();
  job.salvaged_from_legacy_persistence_gap=true;
  job.updated_at=job.salvaged_at;
  await redis.set("recover:acq:"+id,JSON.stringify(job),{EX:JOB_TTL});

  summary.push({
    id,location:job.location,status:job.status,
    old_qualified_count:Number(job.qualified_count||0),
    raw_count:raw.length,
    salvaged_no_website_contactable:qualified.length,
    stored_count:persisted.length,
    error:job.error||null
  });
}
console.log(JSON.stringify({ok:true,summary}));
await redis.quit();