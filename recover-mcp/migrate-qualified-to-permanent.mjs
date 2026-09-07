import { createClient } from "redis";
const redis=createClient({url:process.env.ACQUISITION_REDIS_URL||""});
await redis.connect();
const ids=[
 "b7a7858d-32a6-46c9-823c-0e477f938955",
 "99126613-c5ad-49c7-9fa5-1e92fd70e14b",
 "0861b272-d805-4af2-a084-71169153c7f8",
 "b28d3596-e31f-47ce-8342-040c3895ad67",
 "df431879-e411-4536-bf87-a154ec180e84",
 "70bdb7ce-b723-4dd3-9b42-6e3caad11549",
 "da4e910b-3f53-4263-9d7b-f03a161a6ecb"
];
function normPhone(v=""){return String(v).replace(/\D/g,"").slice(-10);}
function normDomain(v=""){try{const u=new URL(/^https?:\/\//i.test(v)?v:"https://"+v);return u.hostname.toLowerCase().replace(/^www\./,"");}catch{return String(v).toLowerCase().replace(/^www\./,"").replace(/\/$/,"");}}
function normText(v=""){return String(v).toLowerCase().replace(/[^a-z0-9]+/g," ").trim();}
function ident(x){
 if(x.place_id) return "place:"+String(x.place_id).trim();
 const d=normDomain(x.website||""); if(d) return "domain:"+d;
 const p=normPhone(x.phone||""); if(p) return "phone:"+p;
 return "nameaddr:"+normText((x.name||x.title||"")+"|"+(x.address||""));
}
let written=0;
for(const id of ids){
 const jr=await redis.get("recover:acq:"+id); if(!jr) continue;
 const job=JSON.parse(jr);
 const rows=await redis.lRange("recover:acq:"+id+":results",0,-1);
 for(const raw of rows){
   let x; try{x=JSON.parse(raw)}catch{continue}
   const value={...x,acquisition_id:id,acquisition_location:job.location||"",industry:job.industry||"",persisted_at:new Date().toISOString()};
   await redis.hSet("recover:leadstore:qualified",ident(value),JSON.stringify(value));
   written++;
 }
}
console.log(JSON.stringify({ok:true,written,permanent_count:await redis.hLen("recover:leadstore:qualified")}));
await redis.quit();