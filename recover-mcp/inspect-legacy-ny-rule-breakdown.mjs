import { createClient } from "redis";
const redis=createClient({url:process.env.ACQUISITION_REDIS_URL||""});
await redis.connect();
const jobs={
 Brooklyn:"b7a7858d-32a6-46c9-823c-0e477f938955",
 Bronx:"99126613-c5ad-49c7-9fa5-1e92fd70e14b",
 LongIsland:"0861b272-d805-4af2-a084-71169153c7f8",
 Westchester:"b28d3596-e31f-47ce-8342-040c3895ad67",
 Buffalo:"df431879-e411-4536-bf87-a154ec180e84"
};
function emails(v){const a=Array.isArray(v)?v:String(v||"").split(/[;,\s]+/);return a.filter(x=>/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(x).trim()));}
for(const [name,id] of Object.entries(jobs)){
 const rows=(await redis.lRange("recover:acq:"+id+":raw",0,-1)).map(x=>JSON.parse(x));
 const noWebsite=rows.filter(x=>!String(x.website||"").trim());
 const contact=rows.filter(x=>String(x.phone||"").trim()||emails(x.emails||x.email||"").length);
 const both=noWebsite.filter(x=>String(x.phone||"").trim()||emails(x.emails||x.email||"").length);
 console.log(JSON.stringify({name,id,total:rows.length,noWebsite:noWebsite.length,contactable:contact.length,noWebsiteContactable:both.length,sampleNoWebsite:both.slice(0,5).map(x=>({name:x.name||x.title,address:x.address,phone:x.phone,email:x.email||x.emails,website:x.website}))}));
}
await redis.quit();