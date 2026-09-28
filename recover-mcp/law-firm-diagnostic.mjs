import { createClient } from "redis";
const url=process.env.ACQUISITION_REDIS_URL||"";
if(!url) throw new Error("ACQUISITION_REDIS_URL required");
const redis=createClient({url,socket:{connectTimeout:10000,keepAlive:5000}});
redis.on("error",e=>console.error("diagnostic redis error",String(e?.message||e)));
await redis.connect();

const LEAD_HASH="recover:leadstore:qualified";
const QUALIFIED_SET="recover:law-firm:qualified:v2";
const ENRICHED_SET="recover:law-firm:enriched:v2";
const REJECTED_SET="recover:law-firm:rejected:v2";
const PENDING_SET="recover:law-firm:enrich-pending:v2";
const LAW_QUEUE="recover:acquisition:queue:law-firm";

const [candidateTotal,qualifiedTotal,enrichedTotal,rejectedTotal,pendingTotal,queueDepth,byPractice,byDay]=await Promise.all([
  redis.hLen(LEAD_HASH),redis.sCard(QUALIFIED_SET),redis.sCard(ENRICHED_SET),redis.sCard(REJECTED_SET),
  redis.sCard(PENDING_SET),redis.lLen(LAW_QUEUE),
  redis.hGetAll("recover:law-firm:qualified-by-practice:v2"),
  redis.hGetAll("recover:law-firm:qualified-by-day:v2")
]);

const qualifiedKeys=await redis.sMembers(QUALIFIED_SET);
let withEmail=0,withPain=0,withPersonalization=0,preferred2to10=0;
const samples=[];
for(let i=0;i<qualifiedKeys.length;i+=250){
  const keys=qualifiedKeys.slice(i,i+250);
  const raws=await redis.hmGet(LEAD_HASH,keys);
  for(let j=0;j<keys.length;j++){
    let lead;try{lead=raws[j]?JSON.parse(raws[j]):null;}catch{}
    if(!lead)continue;
    const emails=[...(Array.isArray(lead.emails)?lead.emails:[]),lead.email].filter(Boolean);
    if(emails.length)withEmail++;
    if(String(lead.primary_pain_point||"").trim())withPain++;
    if(String(lead.personalization_fact||"").trim())withPersonalization++;
    const n=Number(lead.attorney_count_estimate||0);
    if(n>=2&&n<=10)preferred2to10++;
    if(samples.length<8)samples.push({
      name:lead.name||"",
      target_area:lead.target_area||lead.acquisition_location||"",
      practice_areas:lead.practice_areas||[],
      email_count:emails.length,
      attorney_count_estimate:n||null,
      firm_size_tier:lead.firm_size_tier||"",
      personalization_fact:lead.personalization_fact||"",
      primary_pain_point:lead.primary_pain_point||"",
      email_angle:lead.email_angle||"",
      lead_priority_score:lead.lead_priority_score||0
    });
  }
}

const topAreas=Object.entries(await redis.hGetAll("recover:law-firm:qualified-by-area:v2"))
  .map(([area,count])=>({area,count:Number(count||0)}))
  .sort((a,b)=>b.count-a.count).slice(0,12);

console.log(JSON.stringify({
  event:"law_firm_v2_diagnostic",
  candidateTotal,qualifiedTotal,enrichedTotal,rejectedTotal,pendingTotal,queueDepth,
  withEmail,withPain,withPersonalization,preferred2to10,
  byPractice:Object.fromEntries(Object.entries(byPractice).map(([k,v])=>[k,Number(v||0)])),
  byDay:Object.fromEntries(Object.entries(byDay).map(([k,v])=>[k,Number(v||0)])),
  topAreas,samples
},null,2));
await redis.quit();
