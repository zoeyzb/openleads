import { createClient } from "redis";
import { campaignLeadSetKey, qualificationProfile } from "./acquisition-coverage.mjs";

const REDIS_URL=process.env.ACQUISITION_REDIS_URL||"";
if(!REDIS_URL) throw new Error("ACQUISITION_REDIS_URL required");

const profileJob={
  industry:"HVAC",
  require_no_website:true,
  require_contact:true,
  require_phone:false,
  require_email:false,
  include_no_website:true,
  min_score:30
};
const redis=createClient({url:REDIS_URL});
await redis.connect();
const setKey=campaignLeadSetKey(profileJob);
const expectedProfile=qualificationProfile(profileJob);
const all=await redis.hGetAll("recover:leadstore:qualified");
const jobCache=new Map();
let scanned=0,added=0,rejected=0;

const emailsOf=v=>{
  const arr=Array.isArray(v)?v:String(v||"").split(/[;,\s]+/);
  return arr.map(x=>String(x).trim().toLowerCase()).filter(x=>/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
};

for(const [identity,raw] of Object.entries(all)){
  scanned++;
  let lead; try{lead=JSON.parse(raw)}catch{rejected++;continue}
  if(lead.website){rejected++;continue}
  if(!lead.phone && !emailsOf(lead.emails||lead.email||"").length){rejected++;continue}

  let matches=false;
  if(lead.campaign_scope===setKey) matches=true;

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

  if(!matches && String(lead.industry||"").toLowerCase()==="hvac"){
    const score=Number(lead?.qualification?.score||0);
    if(score>=30) matches=true;
  }

  if(matches){
    added+=await redis.sAdd(setKey,identity);
  }else{
    rejected++;
  }
}
console.log(JSON.stringify({
  ok:true,
  scope_set:setKey,
  scanned,
  newly_added:added,
  total_scoped:await redis.sCard(setKey),
  rejected
}));
await redis.quit();
