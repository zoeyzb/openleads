// capacity-profile: 14 active workers, 14 Maps lanes, queue 84, seed 21
// maps-lane-count-refresh: 14 active lanes as of 2026-09-20
import { createClient } from "redis";
import { randomUUID } from "node:crypto";
import { claimCoverage, campaignLeadSetKey } from "./acquisition-coverage.mjs";
import { isCoreHomeServiceLead, isOwnedBusinessWebsite } from "./home-service-targeting.mjs";
import { deriveSchedulerCapacity, shardIdForArea } from "./nationwide-shard-scheduler.mjs";
import { latePassServiceFamily, LATE_PASS_SERVICE_FAMILIES } from "./late-pass-service-families.mjs";

const REDIS_URL=process.env.ACQUISITION_REDIS_URL||"";
if(!REDIS_URL) throw new Error("ACQUISITION_REDIS_URL required");

const ZIP_SOURCE_URL=process.env.US_ZIP_SOURCE_URL||"https://raw.githubusercontent.com/ReadyAPIs-com/curated-us-zips/main/data/us-zips.csv";
const TARGET_TOTAL=Number(process.env.US_HVAC_TARGET_TOTAL||1000000);
const NY_FIRST_MILESTONE=Number(process.env.NY_HOME_COMFORT_FIRST_MILESTONE||1000);
const ENFORCE_NY_FIRST=String(process.env.ENFORCE_NY_FIRST_MILESTONE||"0")==="1";
const NY_SCOPE_SET="recover:leadstore:ny-home-comfort";
const FIRST_MILESTONE=Number(process.env.US_HVAC_FIRST_MILESTONE||1000);
const scheduler=deriveSchedulerCapacity({
  workerCount:process.env.US_HVAC_WORKER_COUNT||4,
  mapsLaneCount:process.env.US_HVAC_MAPS_LANE_COUNT||6,
  queueHighWater:process.env.US_HVAC_QUEUE_HIGH_WATER,
  seedBatchSize:process.env.US_HVAC_SEED_BATCH_SIZE,
});
const { queueHighWater:QUEUE_HIGH_WATER, seedBatchSize:SEED_BATCH_SIZE, shardCount:SHARD_COUNT }=scheduler;
const QUEUE_LOW_WATER=Math.max(1,Math.floor(QUEUE_HIGH_WATER*0.75));
const TARGET_PER_AREA=Math.min(Math.max(Number(process.env.US_HVAC_ZIP_TARGET_PER_AREA||18),1),36);
const DEPTH=Math.min(Math.max(Number(process.env.US_HVAC_ZIP_DEPTH||6),1),8);
const MAX_ROUNDS=Math.min(Math.max(Number(process.env.US_HVAC_ZIP_MAX_ROUNDS||1),1),2);
const LOOP_MS=Math.max(5000,Number(process.env.US_HVAC_CONTROLLER_LOOP_MS||15000));
const TTL=Number(process.env.ACQUISITION_TTL_SECONDS||604800);
const CONTROLLER_KEY="recover:controller:us-core-home-service:v2";
const BATCH_ID=process.env.US_HVAC_BATCH_ID||"us-core-home-service-1m-v3-2026-09-20";
const PAUSED_NATIONAL_QUEUE="recover:acquisition:queue:paused-national";
const ACTIVE_QUEUE="recover:acquisition:queue";
const NY_PRIORITY_QUEUE="recover:acquisition:queue:ny-priority";
const PAUSED_NY_SURPLUS_QUEUE="recover:acquisition:queue:paused-ny-surplus";
const PAUSED_LEGACY_NATIONAL_QUEUE="recover:acquisition:queue:paused-legacy-national-v1";
const MILLION_DENSE_WAVE_MAX_PASS=Number(process.env.US_HVAC_MILLION_DENSE_WAVE_MAX_PASS||12);
const MILLION_MID_WAVE_MAX_PASS=Number(process.env.US_HVAC_MILLION_MID_WAVE_MAX_PASS||20);
function minPopulationForCoveragePass(pass){
  if(TARGET_TOTAL<1000000||pass<5) return 0;
  if(pass<=MILLION_DENSE_WAVE_MAX_PASS) return 10000;
  if(pass<=MILLION_MID_WAVE_MAX_PASS) return 2500;
  return 0;
}

const profileJob={industry:"HVAC",require_no_website:true,require_contact:true,require_phone:false,require_email:false,include_no_website:true,min_score:30};

function isNyLocation(value=""){return /\bny\b|new york/i.test(String(value||""));}

async function normalizeSocialOnlyLeadstore(redis){
  const all=await redis.hGetAll("recover:leadstore:qualified");
  let changed=0;
  const updates=[];
  for(const [identity,raw] of Object.entries(all)){
    let lead; try{lead=JSON.parse(raw)}catch{continue}
    const website=String(lead.website||"").trim();
    if(!website || isOwnedBusinessWebsite(website)) continue;
    lead.social_profile_url=lead.social_profile_url||website;
    lead.website="";
    lead.website_classification="social_or_directory_profile";
    lead.normalized_at=new Date().toISOString();
    updates.push(identity,JSON.stringify(lead));
    changed++;
    if(updates.length>=1000){await redis.hSet("recover:leadstore:qualified",updates.splice(0,updates.length));}
  }
  if(updates.length) await redis.hSet("recover:leadstore:qualified",updates);
  console.log(JSON.stringify({event:"social_only_leadstore_normalized",changed,total:Object.keys(all).length}));
  return changed;
}

async function bootstrapNyScope(redis){
  const before=await redis.sCard(NY_SCOPE_SET);
  const all=await redis.hGetAll("recover:leadstore:qualified");
  const ids=[];
  for(const [identity,raw] of Object.entries(all)){
    let lead; try{lead=JSON.parse(raw)}catch{continue}
    if(String(lead.website||"").trim()) continue;
    const hasContact=String(lead.phone||"").trim() || (Array.isArray(lead.emails)&&lead.emails.length) || String(lead.email||"").trim();
    if(!hasContact || !isCoreHomeServiceLead(lead)) continue;
    if(!isNyLocation(lead.acquisition_location||lead.region||lead.state||lead.address||"")) continue;
    ids.push(identity);
  }
  const temp=NY_SCOPE_SET+":rebuild:"+Date.now();
  if(ids.length){for(let i=0;i<ids.length;i+=500) await redis.sAdd(temp,ids.slice(i,i+500)); await redis.rename(temp,NY_SCOPE_SET);}else await redis.del(NY_SCOPE_SET);
  const total=await redis.sCard(NY_SCOPE_SET);
  console.log(JSON.stringify({event:"ny_scope_rebuild",before,total,removed:Math.max(0,before-total)}));
  return total;
}

function parseCsvLine(line){
  const out=[]; let cell="",quoted=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(quoted){if(ch==='"'&&line[i+1]==='"'){cell+='"';i++;}else if(ch==='"')quoted=false;else cell+=ch;}
    else{if(ch==='"')quoted=true;else if(ch===','){out.push(cell);cell="";}else cell+=ch;}
  }
  out.push(cell); return out;
}

async function bootstrapScopedLeads(redis,scopeSet){
  const before=await redis.sCard(scopeSet);
  const all=await redis.hGetAll("recover:leadstore:qualified");
  const ids=[];
  const emailList=v=>{const arr=Array.isArray(v)?v:String(v||"").split(/[;,\s]+/); return arr.map(x=>String(x).trim().toLowerCase()).filter(x=>/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));};
  for(const [identity,raw] of Object.entries(all)){
    let lead; try{lead=JSON.parse(raw)}catch{continue}
    if(String(lead.website||"").trim()) continue;
    if(!String(lead.phone||"").trim()&&!emailList(lead.emails||lead.email||"").length) continue;
    if(!isCoreHomeServiceLead(lead)) continue;
    ids.push(identity);
  }
  const temp=scopeSet+":rebuild:"+Date.now();
  if(ids.length){for(let i=0;i<ids.length;i+=500) await redis.sAdd(temp,ids.slice(i,i+500)); await redis.rename(temp,scopeSet);}else await redis.del(scopeSet);
  const total=await redis.sCard(scopeSet);
  console.log(JSON.stringify({event:"scope_rebuild",before,total,removed:Math.max(0,before-total)}));
  return total;
}

function partitionNationwideAreas(rows){
  const states=new Map();
  for(const row of rows){
    if(!states.has(row.state)) states.set(row.state,new Map());
    const cities=states.get(row.state); const cityKey=row.city.toLowerCase();
    if(!cities.has(cityKey)) cities.set(cityKey,{city:row.city,population:0,zips:[]});
    const city=cities.get(cityKey); city.population+=row.population; city.zips.push(row);
  }
  const stateQueues=[];
  for(const [state,citiesMap] of states){
    const cities=[...citiesMap.values()].sort((a,b)=>b.population-a.population||a.city.localeCompare(b.city));
    for(const city of cities) city.zips.sort((a,b)=>b.population-a.population||a.zip.localeCompare(b.zip));
    const ordered=[];
    for(let wave=0;;wave++){
      let added=0;
      for(const city of cities){const area=city.zips[wave]; if(!area)continue; ordered.push({...area,partition_state:state,partition_city:city.city,partition_zip:area.zip}); added++;}
      if(!added) break;
    }
    stateQueues.push({state,population:cities.reduce((sum,city)=>sum+city.population,0),ordered,cursor:0});
  }
  stateQueues.sort((a,b)=>b.population-a.population||a.state.localeCompare(b.state));
  const out=[];
  for(;;){let added=0; for(const state of stateQueues){if(state.cursor>=state.ordered.length)continue; out.push(state.ordered[state.cursor++]); added++;} if(!added)break;}
  return out;
}

async function fetchZipAreas(){
  const res=await fetch(ZIP_SOURCE_URL,{headers:{"user-agent":"Recover-Scrape/1.0"}}); if(!res.ok) throw new Error("zip source failed "+res.status);
  const text=await res.text(); const lines=text.split(/\r?\n/).filter(Boolean); if(lines.length<2)throw new Error("zip source empty");
  const header=parseCsvLine(lines[0]).map(x=>x.trim()); const idx=Object.fromEntries(header.map((x,i)=>[x,i]));
  for(const key of ["zip_code","city","state","population"]) if(idx[key]===undefined) throw new Error("zip source missing column "+key);
  const out=[];
  for(const line of lines.slice(1)){
    const row=parseCsvLine(line);
    const zip=String(row[idx.zip_code]||"").trim().padStart(5,"0");
    const city=String(row[idx.city]||"").trim();
    const state=String(row[idx.state]||"").trim().toUpperCase();
    const population=Number(String(row[idx.population]||"0").replace(/[^0-9.-]/g,""))||0;
    const latitude=idx.latitude===undefined?null:Number(row[idx.latitude]);
    const longitude=idx.longitude===undefined?null:Number(row[idx.longitude]);
    if(!/^\d{5}$/.test(zip)||!city||!/^[A-Z]{2}$/.test(state)||["PR","VI","GU","AS","MP"].includes(state))continue;
    out.push({zip,city,state,population,latitude:Number.isFinite(latitude)?latitude:null,longitude:Number.isFinite(longitude)?longitude:null,location:`${zip} ${city}, ${state}`});
  }
  if(!out.length) throw new Error("zip source parsed zero areas"); return partitionNationwideAreas(out);
}

const redis=createClient({url:REDIS_URL}); redis.on("error",e=>console.error("Redis error",e)); await redis.connect();

async function chooseLatePassServiceFamily(area={},pass=5){
  const fallback=latePassServiceFamily(area,pass);
  if(pass<5||!LATE_PASS_SERVICE_FAMILIES.length) return fallback;
  try{
    const families=LATE_PASS_SERVICE_FAMILIES.map(x=>String(x||"").trim()).filter(Boolean);
    const keys=families.map(x=>x.toLowerCase());
    const state=String(area.partition_state||area.state||"").trim().toLowerCase();
    const city=String(area.partition_city||area.city||"").trim().toLowerCase();
    const areaFields=keys.map(k=>[state,city,"*",k].join("|"));
    const [qAttempts,qNew,qDup,pAttempts,pNew,pDup,aAttempts]=await Promise.all([
      redis.hmGet("recover:yield:query:attempts",keys),
      redis.hmGet("recover:yield:query:new",keys),
      redis.hmGet("recover:yield:query:duplicates",keys),
      redis.hmGet(`recover:yield:query:p${pass}:attempts`,keys),
      redis.hmGet(`recover:yield:query:p${pass}:new`,keys),
      redis.hmGet(`recover:yield:query:p${pass}:duplicates`,keys),
      redis.hmGet("recover:yield:area:attempts",areaFields),
    ]);
    const ranked=families.map((family,i)=>{
      const attempts=Number(qAttempts?.[i]||0);
      const netNew=Number(qNew?.[i]||0);
      const dup=Number(qDup?.[i]||0);
      const areaAttempts=Number(aAttempts?.[i]||0);
      const avgNew=attempts?netNew/attempts:0;
      const dupRate=(netNew+dup)?dup/(netNew+dup):0;
      const recentAttempts=Number(pAttempts?.[i]||0);
      const recentNew=Number(pNew?.[i]||0);
      const recentDup=Number(pDup?.[i]||0);
      const recentAvg=recentAttempts?recentNew/recentAttempts:0;
      const recentDupRate=(recentNew+recentDup)?recentDup/(recentNew+recentDup):0;
      const recentWeight=Math.min(1,recentAttempts/8);
      const blendedAvg=(recentAvg*recentWeight)+(avgNew*(1-recentWeight));
      const blendedDup=(recentDupRate*recentWeight)+(dupRate*(1-recentWeight));
      const utility=(blendedAvg*150)-(blendedDup*20)+(recentAttempts<4?7:0)+(attempts<12?3:0);
      return {family,utility,areaAttempts,attempts,avgNew,dupRate,recentAttempts,recentAvg,recentDupRate};
    });

    const minAreaAttempts=Math.min(...ranked.map(x=>x.areaAttempts));
    const cityEligible=ranked.filter(x=>x.areaAttempts===minAreaAttempts);
    const exploit=[...cityEligible].sort((a,b)=>b.utility-a.utility||b.avgNew-a.avgNew||a.attempts-b.attempts);
    const explore=[...cityEligible].sort((a,b)=>a.attempts-b.attempts||a.dupRate-b.dupRate||b.avgNew-a.avgNew);

    let hash=0;
    for(const ch of `${state}|${city}|${String(area.partition_zip||area.zip||"")}|p${pass}`) hash=(hash*31+ch.charCodeAt(0))>>>0;
    const exploration=(hash%100)<28;
    let pick;
    if(exploration){
      const pool=explore.slice(0,Math.min(8,explore.length));
      pick=pool[pool.length?hash%pool.length:0];
    }else{
      // Never let the single global winner monopolize the fleet. Spread
      // exploitation over the top six families with deterministic weights.
      const pool=exploit.slice(0,Math.min(6,exploit.length));
      const weights=[32,22,16,12,10,8].slice(0,pool.length);
      const total=weights.reduce((s,x)=>s+x,0)||1;
      let slot=(hash>>>8)%total,idx=0;
      while(idx<weights.length-1&&slot>=weights[idx]){slot-=weights[idx];idx++;}
      pick=pool[idx]||pool[0];
    }
    if(pick){
      console.log(JSON.stringify({
        event:"adaptive_family_pick",coveragePass:pass,state,city,family:pick.family,
        mode:exploration?"explore":"exploit",poolSize:exploration?Math.min(8,explore.length):Math.min(6,exploit.length),
        areaAttempts:pick.areaAttempts,globalAttempts:pick.attempts,
        globalAvgNew:Number(pick.avgNew.toFixed(3)),globalDupRate:Number(pick.dupRate.toFixed(3)),
        recentAttempts:pick.recentAttempts,recentAvgNew:Number(pick.recentAvg.toFixed(3)),
        recentDupRate:Number(pick.recentDupRate.toFixed(3))
      }));
      return pick.family;
    }
  }catch(error){console.warn("adaptive family pick failed",error?.message||error);}
  return fallback;
}
const areas=await fetchZipAreas(); const scopeSet=campaignLeadSetKey(profileJob); await normalizeSocialOnlyLeadstore(redis); await bootstrapScopedLeads(redis,scopeSet); await bootstrapNyScope(redis);
let cursor=Number(await redis.hGet(CONTROLLER_KEY,"cursor")||0); let coveragePass=Math.max(1,Number(await redis.hGet(CONTROLLER_KEY,"coverage_pass")||1));
const geoMultiCellResetDone=String(await redis.hGet(CONTROLLER_KEY,"geo_multi_cell_v1")||"")==="1";
if(TARGET_TOTAL>=1000000&&coveragePass>=8&&!geoMultiCellResetDone){
  cursor=0;
  await redis.hSet(CONTROLLER_KEY,{cursor:"0",geo_multi_cell_v1:"1"});
  console.log(JSON.stringify({event:"geo_multi_cell_reset",coveragePass,cursor,reason:"enable_multi_cell_dense_city_coverage"}));
}
const hybridResetDone=String(await redis.hGet(CONTROLLER_KEY,"hybrid_zip_v3")||"")==="1";
if(!hybridResetDone){
  coveragePass=Math.max(5,coveragePass);
  cursor=0;
  await redis.hSet(CONTROLLER_KEY,{cursor:"0",coverage_pass:String(coveragePass),hybrid_zip_v3:"1"});
  console.log(JSON.stringify({event:"hybrid_zip_coverage_reset",coveragePass,cursor,reason:"fresh_pass_to_avoid_stale_pass4_claims"}));
}
console.log("US HVAC ZIP controller v3 started",JSON.stringify({areas:areas.length,target:TARGET_TOTAL,scopeSet,cursor,targetPerArea:TARGET_PER_AREA,maxRounds:MAX_ROUNDS,depth:DEPTH,queueHighWater:QUEUE_HIGH_WATER,queueLowWater:QUEUE_LOW_WATER,seedBatchSize:SEED_BATCH_SIZE,coveragePass,partitioning:"state>city>zip",scheduler,enforceNyFirst:ENFORCE_NY_FIRST}));

async function parkNySurplus(){
  let moved=0,missing=0,already=0;
  while(true){const id=await redis.rPop(NY_PRIORITY_QUEUE); if(!id)break; const raw=await redis.get("recover:acq:"+id); if(!raw){missing++;continue;} let job;try{job=JSON.parse(raw)}catch{missing++;continue;} if(String(job.status||"")!=="queued")continue; job.status="parked";job.phase="parked_ny_surplus";job.updated_at=new Date().toISOString();await redis.set("recover:acq:"+id,JSON.stringify(job),{EX:TTL});const pos=await redis.lPos(PAUSED_NY_SURPLUS_QUEUE,String(id));if(pos===null){await redis.lPush(PAUSED_NY_SURPLUS_QUEUE,String(id));moved++;}else already++;}
  return {moved,missing,already,remainingPriority:await redis.lLen(NY_PRIORITY_QUEUE),pausedNySurplus:await redis.lLen(PAUSED_NY_SURPLUS_QUEUE)};
}

async function resumePausedNational(maxToMove){
  let moved=0,duplicates=0; const limit=Math.max(0,Number(maxToMove||0));
  while(moved<limit){const id=await redis.rPop(PAUSED_NATIONAL_QUEUE);if(!id)break;const pos=await redis.lPos(ACTIVE_QUEUE,String(id));if(pos===null){await redis.lPush(ACTIVE_QUEUE,String(id));moved++;}else duplicates++;}
  return {moved,duplicates,remaining:await redis.lLen(PAUSED_NATIONAL_QUEUE)};
}

async function parkLegacyNationalForV2(){
  const ids=await redis.lRange(ACTIVE_QUEUE,0,-1); const now=Date.now(); let parked=0,keptV2=0,keptLeased=0,keptFresh=0,removedTerminal=0,missing=0;
  for(const id of ids){
    const raw=await redis.get("recover:acq:"+id); if(!raw){await redis.lRem(ACTIVE_QUEUE,0,String(id));missing++;continue;}
    let job;try{job=JSON.parse(raw)}catch{await redis.lRem(ACTIVE_QUEUE,0,String(id));missing++;continue;}
    const isV2=String(job.batch_id||"").startsWith("us-core-home-service-100k-v2")||String(job.coverage_pass||"").startsWith("us-core-v2-"); if(isV2){keptV2++;continue;}
    const status=String(job.status||""); const updated=Date.parse(job.updated_at||job.started_at||job.created_at||0); const ageMs=updated?Math.max(0,now-updated):Number.POSITIVE_INFINITY; const leased=Boolean(await redis.exists("recover:acq:"+id+":lease"));
    if(leased){keptLeased++;continue;}
    if(["complete","partial_complete","failed","error","parked"].includes(status)){await redis.lRem(ACTIVE_QUEUE,0,String(id));if(status==="parked"&&await redis.lPos(PAUSED_LEGACY_NATIONAL_QUEUE,String(id))===null)await redis.lPush(PAUSED_LEGACY_NATIONAL_QUEUE,String(id));removedTerminal++;continue;}
    const stale=status==="queued"||(status==="running"&&ageMs>180000); if(!stale){keptFresh++;continue;}
    await redis.lRem(ACTIVE_QUEUE,0,String(id)); job.status="parked";job.phase=status==="running"?"parked_stale_legacy_no_lease":"parked_legacy_national_v1";job.updated_at=new Date().toISOString();await redis.set("recover:acq:"+id,JSON.stringify(job),{EX:TTL});if(await redis.lPos(PAUSED_LEGACY_NATIONAL_QUEUE,String(id))===null)await redis.lPush(PAUSED_LEGACY_NATIONAL_QUEUE,String(id));parked++;
  }
  const result={event:"legacy_national_reconciled_for_v2",snapshot:ids.length,parked,keptV2,keptLeased,keptFresh,removedTerminal,missing,activeAfter:await redis.lLen(ACTIVE_QUEUE),pausedLegacy:await redis.lLen(PAUSED_LEGACY_NATIONAL_QUEUE)};console.log(JSON.stringify(result));return result;
}

async function upgradeQueuedNationalJobs(){
  const ids=await redis.lRange(ACTIVE_QUEUE,0,-1);
  let upgraded=0,skipped=0,cityDuplicatesParked=0,yieldExhaustedParked=0,yieldExplorationKept=0;
  const seenLaterPassCities=new Map();
  for(const id of ids){
    const raw=await redis.get("recover:acq:"+id);
    if(!raw){skipped++;continue;}
    let job;try{job=JSON.parse(raw)}catch{skipped++;continue;}
    if(String(job.status||"")!=="queued"||Number(job.round||0)>0){skipped++;continue;}
    const industry=String(job.industry||"").toLowerCase();
    if(!/hvac|home.comfort|home.service|heating|cooling|plumb/.test(industry)){skipped++;continue;}
    job.search_profile="core-home-service";
    job.max_rounds=Math.min(Number(job.max_rounds||MAX_ROUNDS),MAX_ROUNDS);
    job.depth=Math.min(Number(job.depth||DEPTH),DEPTH);
    job.target=Math.min(Number(job.target||TARGET_PER_AREA),TARGET_PER_AREA);
    const passMatch=String(job.coverage_pass||"").match(/p(\d+)$/);
    const pass=Number(passMatch?.[1]||1);
    const partitionState=String(job.partition_state||"").trim();
    const partitionCity=String(job.partition_city||"").trim();
    const partitionZip=String(job.partition_zip||job.source_zip||"").trim();
    const denseLaterPass=pass>=3&&Number(job.source_population||0)>=10000;
    const cityScopedPass=pass>=5;
    if(cityScopedPass&&!String(job.query_family||"").trim()){
      job.query_family=latePassServiceFamily(job,pass);
    }
    const serviceFamily=String(job.query_family||"").trim().toLowerCase();
    const minPopulation=minPopulationForCoveragePass(pass);
    if(minPopulation>0&&Number(job.source_population||0)<minPopulation){
      await redis.lRem(ACTIVE_QUEUE,0,String(id));
      job.status="parked";
      job.phase="parked_low_density_productive_wave";
      job.reason="deferred_until_lower_density_coverage_phase";
      job.updated_at=new Date().toISOString();
      await redis.set("recover:acq:"+id,JSON.stringify(job),{EX:TTL});
      cityDuplicatesParked++;
      continue;
    }
    const yieldField=[partitionState.toLowerCase(),partitionCity.toLowerCase(),(cityScopedPass||pass>=3&&!denseLaterPass)?"*":partitionZip.toLowerCase(),cityScopedPass?serviceFamily:""].join("|");
    if(pass>=2&&yieldField!=="||"){
      const [attemptsRaw,newRaw,dupRaw]=await Promise.all([
        redis.hGet("recover:yield:area:attempts",yieldField),
        redis.hGet("recover:yield:area:new",yieldField),
        redis.hGet("recover:yield:area:duplicates",yieldField),
      ]);
      const attempts=Number(attemptsRaw||0),netNew=Number(newRaw||0),dups=Number(dupRaw||0);
      const avgNew=attempts?netNew/attempts:0;
      const dupRate=(netNew+dups)?dups/(netNew+dups):0;
      const exhausted=(attempts>=1&&netNew===0&&dups>=8) ||
        (attempts>=2&&avgNew<0.5&&dupRate>=0.85) ||
        (attempts>=5&&avgNew<1);
      let hash=0;
      const seed=`${partitionState}|${partitionCity}|${partitionZip}|p${pass}`;
      for(const ch of seed) hash=(hash*31+ch.charCodeAt(0))>>>0;
      const exploration=exhausted&&hash%20===0;
      if(exhausted&&!exploration){
        await redis.lRem(ACTIVE_QUEUE,0,String(id));
        job.status="parked";
        job.phase="parked_yield_exhausted";
        job.reason="queued_area_duplicate_saturation";
        job.updated_at=new Date().toISOString();
        await redis.set("recover:acq:"+id,JSON.stringify(job),{EX:TTL});
        yieldExhaustedParked++;
        continue;
      }
      if(exploration) yieldExplorationKept++;
    }
    if(pass>=3&&Number(job.source_population||0)>=10000&&pass<5){
      const zip=String(job.partition_zip||job.source_zip||"").trim();
      const city=String(job.partition_city||"").trim();
      const state=String(job.partition_state||"").trim();
      if(zip&&city&&state) job.location=`${zip} ${city}, ${state}`;
    }
    if(pass>=3&&(Number(job.source_population||0)<10000||pass>=5)){
      const city=String(job.partition_city||"").trim();
      const state=String(job.partition_state||"").trim();
      const population=Number(job.source_population||0);
      const zip=String(job.partition_zip||job.source_zip||"").trim();
      const geoCellMode=pass>=8&&population>=10000&&Boolean(zip);
      const cityKey=(pass+"|"+state+"|"+city).toLowerCase();
      if(city&&state){
        const seen=Number(seenLaterPassCities.get(cityKey)||0);
        const cap=geoCellMode?(population>=25000?3:2):1;
        if(seen>=cap){
          await redis.lRem(ACTIVE_QUEUE,0,String(id));
          job.status="parked";
          job.phase=geoCellMode?"parked_duplicate_city_cell_cap":"parked_duplicate_city_pass";
          job.reason=geoCellMode?"geo_cell_cap_reached":"duplicate_city_in_later_coverage_pass";
          job.updated_at=new Date().toISOString();
          await redis.set("recover:acq:"+id,JSON.stringify(job),{EX:TTL});
          cityDuplicatesParked++;
          continue;
        }
        seenLaterPassCities.set(cityKey,seen+1);
        if(geoCellMode) job.coverage_cell=job.coverage_cell||`zip:${zip}`;
        job.location=`${city}, ${state}`;
      }
    }
    job.updated_at=new Date().toISOString();
    await redis.set("recover:acq:"+id,JSON.stringify(job),{EX:TTL});
    upgraded++;
  }
  console.log(JSON.stringify({event:"legacy_queue_upgraded",queue:ids.length,upgraded,skipped,cityDuplicatesParked,yieldExhaustedParked,yieldExplorationKept}));
  return upgraded;
}

await upgradeQueuedNationalJobs(); await parkLegacyNationalForV2();

async function seedOne(area){
  const id=randomUUID(),now=new Date().toISOString(); const shard_id=shardIdForArea(area,SHARD_COUNT);
  const partitionState=area.partition_state||area.state;
  const partitionCity=area.partition_city||area.city;
  const denseLaterPass=coveragePass>=3&&Number(area.population||0)>=10000;
  const cityScopedPass=coveragePass>=5;
  const queryFamily=cityScopedPass?await chooseLatePassServiceFamily(area,coveragePass):"";
  const yieldField=[String(partitionState||"").toLowerCase(),String(partitionCity||"").toLowerCase(),(cityScopedPass||coveragePass>=3&&!denseLaterPass)?"*":String(area.partition_zip||area.zip||"").toLowerCase(),String(queryFamily||"").toLowerCase()].join("|");
  let yieldDecision={attempts:0,netNew:0,dups:0,avgNew:0,dupRate:0,exhausted:false,exploration:false};
  if(coveragePass>=2 && yieldField!=="||"){
    const [attemptsRaw,newRaw,dupRaw]=await Promise.all([
      redis.hGet("recover:yield:area:attempts",yieldField),
      redis.hGet("recover:yield:area:new",yieldField),
      redis.hGet("recover:yield:area:duplicates",yieldField),
    ]);
    const attempts=Number(attemptsRaw||0),netNew=Number(newRaw||0),dups=Number(dupRaw||0);
    const avgNew=attempts?netNew/attempts:0;
    const dupRate=(netNew+dups)?dups/(netNew+dups):0;
    const exhausted=(attempts>=1&&netNew===0&&dups>=8) ||
      (attempts>=2&&avgNew<0.5&&dupRate>=0.85) ||
      (attempts>=5&&avgNew<1);
    let hash=0;
    const explorationSeed=`${partitionState||""}|${partitionCity||""}|${area.partition_zip||area.zip||""}|p${coveragePass}`;
    for(const ch of explorationSeed) hash=(hash*31+ch.charCodeAt(0))>>>0;
    const exploration=exhausted&&hash%20===0;
    yieldDecision={attempts,netNew,dups,avgNew,dupRate,exhausted,exploration};
    if(exhausted&&!exploration){
      await redis.hIncrBy(CONTROLLER_KEY,"yield_skipped_total",1);
      return false;
    }
    if(exploration) await redis.hIncrBy(CONTROLLER_KEY,"yield_exploration_total",1);
  }
  let cityPassKey="",cityField="",cityMarked=false,cityMarkMode="";
  const sourcePopulation=Number(area.population||0);
  const geoCellMode=coveragePass>=8&&sourcePopulation>=10000;
  const geoCellCap=sourcePopulation>=25000?3:2;
  const coverageCell=geoCellMode?`zip:${String(area.partition_zip||area.zip||"").trim()}`:"";
  if(coveragePass>=3&&(!denseLaterPass||coveragePass>=5)){
    cityField=`${String(partitionState||"").toLowerCase()}|${String(partitionCity||"").toLowerCase()}`;
    if(geoCellMode){
      cityPassKey=`recover:coverage:city-pass-cells:${coveragePass}`;
      const count=await redis.hIncrBy(cityPassKey,cityField,1);
      await redis.expire(cityPassKey,TTL);
      if(count>geoCellCap){
        await redis.hIncrBy(cityPassKey,cityField,-1);
        return false;
      }
      cityMarked=true;
      cityMarkMode="hash";
    }else{
      cityPassKey=`recover:coverage:city-pass:${coveragePass}`;
      const firstForCity=await redis.sAdd(cityPassKey,cityField);
      await redis.expire(cityPassKey,TTL);
      if(!firstForCity) return false;
      cityMarked=true;
      cityMarkMode="set";
    }
  }
  const job={id,batch_id:BATCH_ID,industry:"HVAC",search_profile:"core-home-service",coverage_pass:`us-core-v2-p${coveragePass}`,coverage_cell:coverageCell,partition_state:partitionState,partition_city:partitionCity,partition_zip:area.partition_zip||area.zip,shard_id,location:locationForCoveragePass(area,coveragePass),query_family:queryFamily,target:TARGET_PER_AREA,min_score:30,require_phone:false,require_email:false,require_contact:true,require_no_website:true,include_no_website:true,max_rounds:MAX_ROUNDS,depth:DEPTH,status:"queued",phase:"queued",round:0,rounds_completed:0,raw_count:0,unique_count:0,qualified_count:0,stored_count:0,maps_jobs:[],source:"us_core_partition_controller_v3",source_zip:area.zip,source_population:area.population,source_latitude:area.latitude,source_longitude:area.longitude,yield_exploration:Boolean(yieldDecision.exploration),prior_area_attempts:yieldDecision.attempts,prior_area_net_new:yieldDecision.netNew,prior_area_duplicate_rate:yieldDecision.dupRate,created_at:now,updated_at:now};
  const claim=await claimCoverage(redis,job,{source:"us_core_partition_controller_v3",source_zip:area.zip,source_population:area.population,partition_state:job.partition_state,partition_city:job.partition_city,coverage_pass:job.coverage_pass,coverage_cell:job.coverage_cell,shard_id});
  if(!claim.claimed){
    if(cityMarked){
      if(cityMarkMode==="hash") await redis.hIncrBy(cityPassKey,cityField,-1);
      else await redis.sRem(cityPassKey,cityField);
    }
    return false;
  }
  await redis.set("recover:acq:"+id,JSON.stringify(job),{EX:TTL});await redis.sAdd("recover:acq:index",id);await redis.sAdd("recover:batch:"+BATCH_ID+":jobs",id);await redis.expire("recover:batch:"+BATCH_ID+":jobs",TTL);if(await redis.lPos(ACTIVE_QUEUE,id)===null)await redis.lPush(ACTIVE_QUEUE,id);return true;
}

while(true){
  try{
    const scoped=await redis.sCard(scopeSet),nyScoped=await redis.sCard(NY_SCOPE_SET),queue=await redis.lLen(ACTIVE_QUEUE),pausedNational=await redis.lLen(PAUSED_NATIONAL_QUEUE);
    await redis.hSet(CONTROLLER_KEY,{scoped_count:String(scoped),queue_len:String(queue),queue_high_water:String(QUEUE_HIGH_WATER),seed_batch_size:String(SEED_BATCH_SIZE),worker_count:String(scheduler.workerCount),maps_lane_count:String(scheduler.mapsLaneCount),shard_count:String(SHARD_COUNT),cursor:String(cursor),coverage_pass:String(coveragePass),partition_state:String(areas[cursor]?.partition_state||areas[cursor]?.state||""),partition_city:String(areas[cursor]?.partition_city||areas[cursor]?.city||""),area_count:String(areas.length),updated_at:new Date().toISOString(),milestone_1000:scoped>=FIRST_MILESTONE?"reached":"pending",ny_priority_count:String(nyScoped),ny_priority_milestone:nyScoped>=NY_FIRST_MILESTONE?"reached":"pending",paused_national_count:String(pausedNational),national_resume_state:(!ENFORCE_NY_FIRST||nyScoped>=NY_FIRST_MILESTONE)?(pausedNational>0?"draining_parked":"active"):"waiting_for_ny",target_total:String(TARGET_TOTAL),target_100k:scoped>=100000?"reached":"pending",target_1m:scoped>=TARGET_TOTAL?"reached":"pending"});
    if(ENFORCE_NY_FIRST&&nyScoped<NY_FIRST_MILESTONE){console.log(JSON.stringify({event:"ny_priority_hold",nyScoped,nyTarget:NY_FIRST_MILESTONE,scoped,queue,pausedNational,cursor}));await new Promise(r=>setTimeout(r,LOOP_MS));continue;}
    const nyPriorityLen=await redis.lLen(NY_PRIORITY_QUEUE);if(!ENFORCE_NY_FIRST&&nyPriorityLen>0){const parkedNy=await parkNySurplus();console.log(JSON.stringify({event:"ny_surplus_parked",nyScoped,nyTarget:NY_FIRST_MILESTONE,...parkedNy}));}
    if(pausedNational>0){const capacity=Math.max(0,QUEUE_HIGH_WATER-queue);if(capacity>0){const resumed=await resumePausedNational(Math.min(capacity,SEED_BATCH_SIZE));console.log(JSON.stringify({event:"national_resume_parked",nyScoped,nyTarget:NY_FIRST_MILESTONE,queue_before:queue,capacity,...resumed}));}else console.log(JSON.stringify({event:"national_resume_backpressure",nyScoped,queue,pausedNational}));await new Promise(r=>setTimeout(r,LOOP_MS));continue;}
    if(scoped>=TARGET_TOTAL){console.log(JSON.stringify({event:"target_reached",scoped,queue,cursor}));await new Promise(r=>setTimeout(r,LOOP_MS));continue;}
    const minPopulation=minPopulationForCoveragePass(coveragePass);
    if(cursor<areas.length&&minPopulation>0&&Number(areas[cursor]?.population||0)<minPopulation){
      const previousPass=coveragePass;
      const skippedTail=areas.length-cursor;
      coveragePass++;
      cursor=0;
      await redis.hSet(CONTROLLER_KEY,{cursor:"0",coverage_pass:String(coveragePass),productive_wave_min_population:String(minPopulation),productive_wave_skipped_tail:String(skippedTail)});
      console.log(JSON.stringify({event:"productive_wave_advanced",previousPass,coveragePass,scoped,minPopulation,skippedTail,reason:"skip_low_density_tail_for_next_service_family"}));
      await new Promise(r=>setTimeout(r,LOOP_MS));
      continue;
    }
    if(cursor>=areas.length&&scoped<TARGET_TOTAL){coveragePass++;cursor=0;await redis.hSet(CONTROLLER_KEY,{cursor:"0",coverage_pass:String(coveragePass)});console.log(JSON.stringify({event:"coverage_pass_advanced",coveragePass,scoped,area_count:areas.length}));}
    if(queue>=QUEUE_LOW_WATER){console.log(JSON.stringify({event:"backpressure",scoped,queue,cursor,queueHighWater:QUEUE_HIGH_WATER,queueLowWater:QUEUE_LOW_WATER}));await new Promise(r=>setTimeout(r,LOOP_MS));continue;}
    const refillLimit=Math.min(SEED_BATCH_SIZE,Math.max(0,QUEUE_HIGH_WATER-queue));
    let seeded=0,checked=0;while(seeded<refillLimit&&cursor<areas.length&&queue+seeded<QUEUE_HIGH_WATER){const area=areas[cursor++];checked++;if(await seedOne(area))seeded++;await redis.hSet(CONTROLLER_KEY,"cursor",String(cursor));}
    console.log(JSON.stringify({event:"seed_cycle",scoped,queue_before:queue,checked,seeded,cursor,coveragePass,queueHighWater:QUEUE_HIGH_WATER,seedBatchSize:SEED_BATCH_SIZE,shardCount:SHARD_COUNT,partition_state:String(areas[Math.max(0,cursor-1)]?.partition_state||""),partition_city:String(areas[Math.max(0,cursor-1)]?.partition_city||""),area_count:areas.length}));
    if(cursor>=areas.length)console.log(JSON.stringify({event:"coverage_pass_complete",scoped,cursor,coveragePass,area_count:areas.length}));
  }catch(error){console.error("Controller loop error",error);}
  await new Promise(r=>setTimeout(r,LOOP_MS));
}
