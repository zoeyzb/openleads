import { createClient } from "redis";
const redis=createClient({url:process.env.ACQUISITION_REDIS_URL||""});
await redis.connect();
const jobs=[
 ["Brooklyn","b7a7858d-32a6-46c9-823c-0e477f938955",198],
 ["Bronx","99126613-c5ad-49c7-9fa5-1e92fd70e14b",116],
 ["Long Island","0861b272-d805-4af2-a084-71169153c7f8",154],
 ["Westchester","b28d3596-e31f-47ce-8342-040c3895ad67",119],
 ["Buffalo","df431879-e411-4536-bf87-a154ec180e84",90]
];
function emails(v){const a=Array.isArray(v)?v:String(v||"").split(/[;,\s]+/);return [...new Set(a.map(x=>String(x).trim().toLowerCase()).filter(x=>/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))];}
for(const [area,id,oldQualified] of jobs){
 const jr=await redis.get("recover:acq:"+id); if(!jr){console.log(JSON.stringify({area,id,error:"missing"}));continue;}
 const job=JSON.parse(jr);
 const rows=(await redis.lRange("recover:acq:"+id+":raw",0,-1)).map(x=>JSON.parse(x)).map(x=>{
   const noWebsite=!String(x.website||"").trim();
   const em=emails(x.emails||x.email||"");
   const contactable=!!String(x.phone||"").trim()||em.length>0;
   return {
     area,
     name:x.name||x.title||"",
     category:x.category||x.industry||"",
     address:x.address||"",
     phone:x.phone||"",
     email:em.join(", "),
     website:x.website||"",
     place_id:x.place_id||"",
     review_count:Number(x.review_count||x.reviews||0),
     rating:Number(x.review_rating||x.rating||0),
     acquisition_id:id,
     old_ui_qualified_count:oldQualified,
     old_status:job.status||"",
     no_website:noWebsite,
     contactable,
     campaign_eligible_now:noWebsite&&contactable,
     legacy_note:"Old UI qualified counter used score threshold and did not enforce no-website-only",
     source:"recover:acq:"+id+":raw"
   };
 });
 console.log(JSON.stringify({area,count:rows.length,rows}));
}
await redis.quit();