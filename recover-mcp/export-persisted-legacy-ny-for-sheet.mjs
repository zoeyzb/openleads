import { createClient } from "redis";
const redis=createClient({url:process.env.ACQUISITION_REDIS_URL||""});
await redis.connect();
const jobs=[
 ["Brooklyn","b7a7858d-32a6-46c9-823c-0e477f938955"],
 ["Bronx","99126613-c5ad-49c7-9fa5-1e92fd70e14b"],
 ["Long Island","0861b272-d805-4af2-a084-71169153c7f8"],
 ["Westchester","b28d3596-e31f-47ce-8342-040c3895ad67"],
 ["Buffalo","df431879-e411-4536-bf87-a154ec180e84"]
];
const out=[];
for(const [area,id] of jobs){
  const jobRaw=await redis.get("recover:acq:"+id);
  if(!jobRaw) continue;
  const job=JSON.parse(jobRaw);
  const rows=await redis.lRange("recover:acq:"+id+":results",0,-1);
  for(const raw of rows){
    try{
      const x=JSON.parse(raw);
      out.push({
        area,
        acquisition_id:id,
        name:x.name||x.title||"",
        category:x.category||x.industry||"",
        address:x.address||"",
        city:x.city||"",
        region:x.region||"",
        phone:x.phone||"",
        email:Array.isArray(x.emails)?x.emails.join(", "):(x.email||x.emails||""),
        website:x.website||"",
        google_maps_url:x.google_maps_url||x.link||"",
        place_id:x.place_id||"",
        review_count:Number(x.review_count||x.reviews||0),
        rating:Number(x.review_rating||x.rating||0),
        score:Number((x.qualification&&x.qualification.score)||0),
        status:"persisted_legacy_recovery"
      });
    }catch{}
  }
}
console.log(JSON.stringify({count:out.length,rows:out}));
await redis.quit();