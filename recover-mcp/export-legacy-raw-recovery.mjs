import { createClient } from "redis";
const redis=createClient({url:process.env.ACQUISITION_REDIS_URL||""});
await redis.connect();
const jobs={
 "Brooklyn":["b7a7858d-32a6-46c9-823c-0e477f938955",198],
 "Bronx":["99126613-c5ad-49c7-9fa5-1e92fd70e14b",116],
 "Long Island":["0861b272-d805-4af2-a084-71169153c7f8",154],
 "Westchester":["b28d3596-e31f-47ce-8342-040c3895ad67",119],
 "Buffalo":["df431879-e411-4536-bf87-a154ec180e84",90]
};
const area=process.env.EXPORT_AREA||"Brooklyn";
const cfg=jobs[area]; if(!cfg) throw new Error("Unknown EXPORT_AREA "+area);
const [id,oldQualified]=cfg;
const jr=await redis.get("recover:acq:"+id); if(!jr) throw new Error("Missing job "+id);
const job=JSON.parse(jr);
const raw=await redis.lRange("recover:acq:"+id+":raw",0,-1);
function emails(v){const a=Array.isArray(v)?v:String(v||"").split(/[;,\s]+/);return [...new Set(a.map(x=>String(x).trim().toLowerCase()).filter(x=>/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))];}
console.log("META "+JSON.stringify({area,id,count:raw.length,old_ui_qualified_count:oldQualified,status:job.status||""}));
for(const line of raw){
 const x=JSON.parse(line);
 const em=emails(x.emails||x.email||"");
 const noWebsite=!String(x.website||"").trim();
 const contactable=!!String(x.phone||"").trim()||em.length>0;
 console.log("ROW "+JSON.stringify([
   area,x.name||x.title||"",x.category||x.industry||"",x.address||"",x.phone||"",em.join(", "),x.website||"",x.place_id||"",
   Number(x.review_count||x.reviews||0),Number(x.review_rating||x.rating||0),id,oldQualified,job.status||"",
   noWebsite?"YES":"NO",contactable?"YES":"NO",(noWebsite&&contactable)?"YES":"NO",
   "Old UI qualified counter did not enforce no-website-only","recover:acq:"+id+":raw"
 ]));
}
await redis.quit();