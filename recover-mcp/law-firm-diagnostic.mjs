import { createClient } from "redis";
const url=process.env.ACQUISITION_REDIS_URL||"";
if(!url) throw new Error("ACQUISITION_REDIS_URL required");
const redis=createClient({url,socket:{connectTimeout:10000,keepAlive:5000}});
redis.on("error",e=>console.error("diagnostic redis error",String(e?.message||e)));
await redis.connect();
const leadHash="recover:leadstore:qualified";
const enrichedSet="recover:law-firm:enriched:v1";
const readySet="recover:law-firm:ready:v1";
const queue="recover:acquisition:queue:law-firm";
const [enriched,ready,queueDepth,totalLeadstore]=await Promise.all([
  redis.sCard(enrichedSet),redis.sCard(readySet),redis.lLen(queue),redis.hLen(leadHash)
]);
let lawFirms=0,withEmail=0,withPersonalization=0,withAttorneyEstimate=0,preferredSize=0;
const samples=[];
for await (const page of redis.hScanIterator(leadHash,{COUNT:500})){
  for(const entry of (Array.isArray(page)?page:[page])){
    if(!entry?.field||entry.value===undefined) continue;
    let lead;try{lead=JSON.parse(entry.value)||{};}catch{continue;}
    if(String(lead.search_profile||"")!=="law-firm"&&String(lead.industry||"").toUpperCase()!=="LAW_FIRM") continue;
    lawFirms++;
    const emails=[...(Array.isArray(lead.emails)?lead.emails:[]),lead.email].filter(Boolean);
    if(emails.length) withEmail++;
    if(String(lead.personalization_fact||"").trim()) withPersonalization++;
    if(Number(lead.attorney_count_estimate||0)>0) withAttorneyEstimate++;
    if(lead.preferred_firm_size===true) preferredSize++;
    if(samples.length<5) samples.push({
      key:entry.field,name:lead.name||"",city:lead.city||"",region:lead.region||"",
      email_count:emails.length,attorney_count_estimate:lead.attorney_count_estimate||null,
      preferred_firm_size:lead.preferred_firm_size===true,
      practice_areas:lead.practice_areas||[],
      personalization_fact:lead.personalization_fact||"",
      personalization_source:lead.personalization_source||""
    });
  }
}
console.log(JSON.stringify({event:"law_firm_diagnostic",totalLeadstore,lawFirms,enriched,ready,queueDepth,withEmail,withPersonalization,withAttorneyEstimate,preferredSize,samples},null,2));
await redis.quit();
