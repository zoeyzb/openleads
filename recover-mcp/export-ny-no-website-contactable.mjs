import { createClient } from "redis";
const redis=createClient({url:process.env.ACQUISITION_REDIS_URL||""});
await redis.connect();
const ids=await redis.sMembers("recover:acq:index");
const out=[]; const seen=new Set();
const normPhone=v=>String(v||"").replace(/\\D/g,"").slice(-10);
const normText=v=>String(v||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
const getEmails=v=>{ const arr=Array.isArray(v)?v:String(v||"").split(/[;,\\s]+/); return [...new Set(arr.map(x=>String(x).trim().toLowerCase()).filter(x=>/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(x)))]; };
const inNY=lead=>{ const hay=normText([lead.address,lead.city,lead.region,lead.state,lead.state_code].filter(Boolean).join(" ")); return /\\bny\\b|new york/.test(hay); };
const push=(lead,job,status)=>{
  if(!inNY(lead)) return;
  if(lead.website) return;
  const emails=getEmails(lead.emails||lead.email||"");
  const phone=lead.phone||"";
  if(!phone && !emails.length) return;
  let key="";
  if(lead.place_id) key="p:"+lead.place_id;
  else if(normPhone(phone)) key="t:"+normPhone(phone);
  else key="n:"+normText((lead.name||lead.title||"")+"|"+(lead.address||""));
  if(seen.has(key)) return; seen.add(key);
  out.push({
    name:lead.name||lead.title||"", category:lead.category||lead.industry||"", address:lead.address||"", city:lead.city||lead.locality||"",
    region:lead.region||lead.state||lead.state_code||"", phone, email:emails.join(", "), website:"", google_maps_url:lead.google_maps_url||lead.link||"",
    place_id:lead.place_id||"", review_count:Number(lead.review_count||lead.reviews||0), rating:Number(lead.review_rating||lead.rating||0),
    score:Number((lead.qualification&&lead.qualification.score)||0), acquisition_location:job.location||"", acquisition_id:job.id||"", status
  });
};
for(const id of ids){
  const raw=await redis.get("recover:acq:"+id); if(!raw) continue;
  let job; try{job=JSON.parse(raw)}catch{continue}
  if(!/new york|\\bny\\b/i.test(job.location||"")) continue;
  const results=await redis.lRange("recover:acq:"+id+":results",0,-1);
  for(const row of results){try{push(JSON.parse(row),job,"persisted")}catch{}}
  if(!results.length || Number(job.stored_count||0)===0){
    const raws=await redis.lRange("recover:acq:"+id+":raw",0,-1);
    for(const row of raws){try{push(JSON.parse(row),job,"salvaged_raw")}catch{}}
  }
}
console.log(JSON.stringify({count:out.length,rows:out.slice(0,500)}));
await redis.quit();