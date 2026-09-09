import { createClient } from "redis";

const REDIS_URL=process.env.ACQUISITION_REDIS_URL||process.env.REDIS_URL||"";
if(!REDIS_URL) throw new Error("ACQUISITION_REDIS_URL required");

const redis=createClient({url:REDIS_URL});
redis.on("error",e=>console.error("Redis error",e));

function text(v=""){return String(v||"").toLowerCase().trim();}
function inNY(lead){
  const address=text(lead.address||lead.full_address||lead.formatted_address);
  const region=text(lead.region||lead.state||lead.state_code||lead.province);
  const city=text(lead.city||lead.locality||lead.town);
  const acq=text(lead.acquisition_location||lead.location);
  return region==="ny"||region==="new york"||
    /,\s*ny\b|new york\b/.test(address)||
    /new york/.test(city)||
    /\bny\b|new york/.test(acq);
}
function noWebsite(lead){return !String(lead.website||lead.domain||"").trim();}
function contactable(lead){
  const phone=String(lead.phone||"").trim();
  const email=String(lead.email||"").trim();
  const emails=Array.isArray(lead.emails)?lead.emails.filter(Boolean):[];
  return Boolean(phone||email||emails.length);
}
function trade(lead){
  const hay=text((lead.name||lead.title||"")+" "+(lead.category||lead.industry||"")+" "+(lead.description||lead.descriptions||""));
  if(/restaurant|cafe|food|retail|grocery|hotel|motel|lawyer|attorney|dentist|doctor|medical|insurance|real estate|auto repair|car dealer|beauty|salon|school|church|marketing|software|computer repair/.test(hay)) return false;
  return /hvac|heating|air conditioning|cooling|mechanical|plumb|furnace|boiler|duct|ventilation|refrigeration/.test(hay);
}
function identity(lead){
  if(lead.place_id) return "place:"+String(lead.place_id).trim();
  if(lead.cid) return "cid:"+String(lead.cid).trim();
  const phone=String(lead.phone||"").replace(/\D/g,"").slice(-10);
  if(phone) return "phone:"+phone;
  const name=text(lead.name||lead.title);
  const address=text(lead.address||lead.full_address||lead.formatted_address);
  return name||address ? "nameaddr:"+name+"|"+address : "";
}

await redis.connect();

const key="recover:leadstore:ny-home-comfort";
const before=await redis.sCard(key);
const rows=await redis.hVals("recover:leadstore:qualified");

let scanned=0, qualified=0, added=0;
const batch=[];
for(const raw of rows){
  scanned++;
  let lead; try{lead=JSON.parse(raw);}catch{continue;}
  if(!inNY(lead)||!noWebsite(lead)||!contactable(lead)||!trade(lead)) continue;
  const id=identity(lead);
  if(!id) continue;
  qualified++;
  batch.push(id);
  if(batch.length>=500){
    const beforeChunk=await redis.sCard(key);
    await redis.sAdd(key,batch);
    const afterChunk=await redis.sCard(key);
    added+=afterChunk-beforeChunk;
    batch.length=0;
  }
}
if(batch.length){
  const beforeChunk=await redis.sCard(key);
  await redis.sAdd(key,batch);
  const afterChunk=await redis.sCard(key);
  added+=afterChunk-beforeChunk;
}
const after=await redis.sCard(key);

console.log(JSON.stringify({
  event:"ny_scope_reconcile_complete",
  scanned,
  strictQualifiedRows:qualified,
  before,
  after,
  delta:after-before,
  addedMeasured:added,
  milestoneReached:after>=1000
},null,2));

await redis.quit();

// trigger reconciliation build 2026-09-10
