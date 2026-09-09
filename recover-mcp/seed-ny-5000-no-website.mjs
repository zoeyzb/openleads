import { createClient } from "redis";
import { randomUUID } from "node:crypto";

const REDIS_URL=process.env.ACQUISITION_REDIS_URL||"";
const TTL=Number(process.env.ACQUISITION_TTL_SECONDS||604800);
if(!REDIS_URL) throw new Error("ACQUISITION_REDIS_URL required");

const areas=[
  "New York, NY",
  "Brooklyn, NY",
  "Bronx, NY",
  "Staten Island, NY",
  "Astoria, NY",
  "Long Island City, NY",
  "Flushing, NY",
  "Jamaica, NY",
  "Forest Hills, NY",
  "Bayside, NY",
  "Ridgewood, NY",
  "Queens Village, NY",
  "Hempstead, NY",
  "Freeport, NY",
  "Garden City, NY",
  "Hicksville, NY",
  "Levittown, NY",
  "Massapequa, NY",
  "Oyster Bay, NY",
  "Huntington, NY",
  "Babylon, NY",
  "Islip, NY",
  "Smithtown, NY",
  "Patchogue, NY",
  "Riverhead, NY",
  "Southampton, NY",
  "Yonkers, NY",
  "White Plains, NY",
  "New Rochelle, NY",
  "Mount Vernon, NY",
  "Scarsdale, NY",
  "Rye, NY",
  "Peekskill, NY",
  "Ossining, NY",
  "Tarrytown, NY",
  "Poughkeepsie, NY",
  "Beacon, NY",
  "Newburgh, NY",
  "Middletown, NY",
  "Kingston, NY",
  "New Paltz, NY",
  "Port Jervis, NY",
  "Albany, NY",
  "Troy, NY",
  "Schenectady, NY",
  "Saratoga Springs, NY",
  "Glens Falls, NY",
  "Syracuse, NY",
  "Auburn, NY",
  "Oswego, NY",
  "Cortland, NY",
  "Utica, NY",
  "Rome, NY",
  "Oneida, NY",
  "Rochester, NY",
  "Canandaigua, NY",
  "Geneva, NY",
  "Ithaca, NY",
  "Elmira, NY",
  "Corning, NY",
  "Buffalo, NY",
  "Niagara Falls, NY",
  "Lockport, NY",
  "Tonawanda, NY",
  "North Tonawanda, NY",
  "Batavia, NY",
  "Jamestown, NY",
  "Dunkirk, NY",
  "Olean, NY",
  "Binghamton, NY",
  "Watertown, NY",
  "Plattsburgh, NY",
  "Potsdam, NY",
  "Massena, NY",
  "Malone, NY"
];
const batchId=process.env.NY5000_BATCH_ID||"ny-hvac-no-website-5000-2026-09-07";
const targetPerArea=Number(process.env.NY5000_TARGET_PER_AREA||110);
const depth=Number(process.env.NY5000_DEPTH||50);
const maxRounds=Number(process.env.NY5000_MAX_ROUNDS||20);
const redis=createClient({url:REDIS_URL});
await redis.connect();

const permanentBefore=await redis.hLen("recover:leadstore:qualified");
const now=new Date().toISOString();
const jobs=[];
for(const location of areas){
  const id=randomUUID();
  const job={
    id,batch_id:batchId,industry:"HOME_COMFORT_TRADES",location,
    target:targetPerArea,min_score:30,
    require_phone:false,require_email:false,require_contact:true,
    require_no_website:true,include_no_website:true,
    max_rounds:maxRounds,depth,
    status:"queued",phase:"queued",round:0,rounds_completed:0,
    raw_count:0,unique_count:0,qualified_count:0,stored_count:0,
    maps_jobs:[],created_at:now,updated_at:now
  };
  await redis.set("recover:acq:"+id,JSON.stringify(job),{EX:TTL});
  await redis.sAdd("recover:acq:index",id);
  await redis.sAdd("recover:batch:"+batchId+":jobs",id);
  await redis.expire("recover:batch:"+batchId+":jobs",TTL);
  await redis.lPush("recover:acquisition:queue:ny-priority",id);
  jobs.push({id,location,target:targetPerArea});
}
await redis.set("recover:batch:"+batchId+":meta",JSON.stringify({
  batch_id:batchId,industry:"HOME_COMFORT_TRADES",region:"New York State",
  rule:"no_website AND (phone OR email)",
  first_milestone:1000,goal_new_unique:5000,
  baseline_permanent_store_count:permanentBefore,
  requested_area_slots:areas.length*targetPerArea,
  area_count:areas.length,target_per_area:targetPerArea,
  depth,max_rounds:maxRounds,status:"queued",created_at:now
}),{EX:TTL});
console.log(JSON.stringify({
  ok:true,batch_id:batchId,area_count:areas.length,
  target_per_area:targetPerArea,requested_area_slots:areas.length*targetPerArea,
  first_milestone:1000,goal_new_unique:5000,baseline_permanent_store_count:permanentBefore,
  depth,max_rounds:maxRounds
}));
await redis.quit();