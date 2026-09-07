import { createClient } from "redis";
import { upsertQualifiedLeads } from "./acquisition-persistence.mjs";
const redis=createClient({url:process.env.ACQUISITION_REDIS_URL||""});
await redis.connect();
const TTL=Number(process.env.ACQUISITION_TTL_SECONDS||604800);
const jobs=[
 ["Brooklyn","b7a7858d-32a6-46c9-823c-0e477f938955"],
 ["Bronx","99126613-c5ad-49c7-8256-2c346f981e2c".replace("257d68a2-1e52-4d7c-8256-2c346f981e2c","99126613-c5ad-49c7-9fa5-1e92fd70e14b")],
 ["Long Island","0861b272-d805-4af2-a084-71169153c7f8"],
 ["Westchester","b28d3596-e31f-47ce-8342-040c3895ad67"],
 ["Buffalo","df431879-e411-4536-bf87-a154ec180e84"]
];
function emails(v){const a=Array.isArray(v)?v:String(v||"").split(/[;,\s]+/);return [...new Set(a.map(x=>String(x).trim().toLowerCase()).filter(x=>/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))];}
function score(x){let s=0;const c=String(x.category||"").toLowerCase();if(/hvac|heating|air conditioning|mechanical/.test(c))s+=15;if(!x.website)s+=20;if(Number(x.review_count||x.reviews||0)>=20)s+=10;if(Number(x.review_rating||x.rating||0)>=4.2)s+=5;if(x.phone)s+=10;if(emails(x.emails||x.email||"").length)s+=10;return Math.min(100,s);}
function compact(x){return {name:x.name||x.title||"",category:x.category||x.industry||"",address:x.address||"",city:x.city||x.locality||"",region:x.region||x.state||x.state_code||"",website:"",phone:x.phone||"",emails:emails(x.emails||x.email||""),google_maps_url:x.link||x.google_maps_url||"",place_id:x.place_id||"",review_count:Number(x.review_count||x.reviews||0),review_rating:Number(x.review_rating||x.rating||0),qualification:{score:score(x),tier:"legacy_salvage"}};}
async function load(k){return (await redis.lRange(k,0,-1)).map(x=>{try{return JSON.parse(x)}catch{return null}}).filter(Boolean);}
async function save(k,rows){await redis.del(k);for(let i=0;i<rows.length;i+=200){const c=rows.slice(i,i+200).map(JSON.stringify);if(c.length)await redis.rPush(k,c);}await redis.expire(k,TTL);}
for(const [area,id] of jobs){
 const rawJob=await redis.get("recover:acq:"+id); if(!rawJob){console.log(JSON.stringify({area,id,error:"missing"}));continue;}
 const job=JSON.parse(rawJob);
 const raw=await load("recover:acq:"+id+":raw");
 const q=raw.filter(x=>!String(x.website||"").trim()).filter(x=>String(x.phone||"").trim()||emails(x.emails||x.email||"").length).map(compact);
 const existing=await load("recover:acq:"+id+":results");
 const persisted=upsertQualifiedLeads(existing,q);
 await save("recover:acq:"+id+":results",persisted);
 job.stored_count=persisted.length; job.salvaged_at=new Date().toISOString(); job.salvaged_from_legacy_persistence_gap=true; job.updated_at=job.salvaged_at;
 await redis.set("recover:acq:"+id,JSON.stringify(job),{EX:TTL});
 console.log(JSON.stringify({area,id,raw:raw.length,stored_count:persisted.length}));
}
await redis.quit();