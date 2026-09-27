import { createClient } from "redis";
import { randomUUID } from "node:crypto";
import { lawFirmPracticeAreas } from "./law-firm-targeting.mjs";
import { campaignLeadSetKey, claimCoverage } from "./acquisition-coverage.mjs";

const REDIS_URL=process.env.ACQUISITION_REDIS_URL||process.env.REDIS_URL||"";
if(!REDIS_URL) throw new Error("ACQUISITION_REDIS_URL required");

const ZIP_SOURCE_URL=process.env.US_ZIP_SOURCE_URL||"https://raw.githubusercontent.com/ReadyAPIs-com/curated-us-zips/main/data/us-zips.csv";
const TARGET_TOTAL=Math.max(100,Number(process.env.LAW_FIRM_TARGET_TOTAL||25000));
const MAX_CITIES=Math.max(50,Number(process.env.LAW_FIRM_MAX_CITIES||1200));
const QUEUE_HIGH_WATER=Math.max(8,Math.min(64,Number(process.env.LAW_FIRM_QUEUE_HIGH_WATER||24)));
const SEED_BATCH=Math.max(1,Math.min(12,Number(process.env.LAW_FIRM_SEED_BATCH||3)));
const ENRICH_BATCH=Math.max(1,Math.min(8,Number(process.env.LAW_FIRM_ENRICH_BATCH||3)));
const LOOP_MS=Math.max(5000,Number(process.env.LAW_FIRM_LOOP_MS||15000));
const FETCH_TIMEOUT_MS=Math.max(3000,Math.min(15000,Number(process.env.LAW_FIRM_FETCH_TIMEOUT_MS||7000)));
const JOB_TTL=Math.max(86400,Number(process.env.ACQUISITION_TTL_SECONDS||604800));
const ACTIVE_QUEUE="recover:acquisition:queue";
const LEAD_HASH="recover:leadstore:qualified";
const SEEDED_SET="recover:law-firm:seeded:v1";
const ENRICHED_SET="recover:law-firm:enriched:v1";
const READY_SET="recover:law-firm:ready:v1";
const STATS="recover:law-firm:stats:v1";
const PROFILE={industry:"LAW_FIRM",require_phone:false,require_email:false,require_contact:true,require_no_website:false,include_no_website:true,min_score:35};
const SCOPE_SET=campaignLeadSetKey(PROFILE);

const redis=createClient({url:REDIS_URL});
redis.on("error",e=>console.error("law-firm redis error",e));
await redis.connect();

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function normalize(v=""){return String(v||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();}
function parseCsvLine(line){
  const out=[];let cell="",quoted=false;
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(quoted){
      if(ch==='"'&&line[i+1]==='"'){cell+='"';i++;}
      else if(ch==='"')quoted=false;else cell+=ch;
    }else{
      if(ch==='"')quoted=true;
      else if(ch===","){out.push(cell);cell="";}
      else cell+=ch;
    }
  }
  out.push(cell);return out;
}
async function loadCities(){
  const r=await fetch(ZIP_SOURCE_URL,{headers:{"user-agent":"Recover-Law-Firm/1.0"}});
  if(!r.ok) throw new Error("zip source failed "+r.status);
  const lines=(await r.text()).split(/\r?\n/).filter(Boolean);
  const header=parseCsvLine(lines.shift()||"").map(x=>x.trim());
  const idx=Object.fromEntries(header.map((x,i)=>[x,i]));
  const byCity=new Map();
  for(const line of lines){
    const row=parseCsvLine(line), city=String(row[idx.city]||"").trim(), state=String(row[idx.state]||"").trim().toUpperCase();
    if(!city||!/^[A-Z]{2}$/.test(state)||["PR","VI","GU","AS","MP"].includes(state))continue;
    const population=Number(String(row[idx.population]||"0").replace(/[^0-9.-]/g,""))||0;
    const key=state+"|"+normalize(city);
    const prev=byCity.get(key);
    if(!prev||population>prev.population)byCity.set(key,{city,state,population,location:`${city}, ${state}`});
  }
  return [...byCity.values()].sort((a,b)=>b.population-a.population).slice(0,MAX_CITIES);
}
async function fetchText(url,timeout=FETCH_TIMEOUT_MS){
  const ctl=new AbortController(), timer=setTimeout(()=>ctl.abort(),timeout);
  try{
    const r=await fetch(url,{signal:ctl.signal,redirect:"follow",headers:{"user-agent":"Mozilla/5.0 (compatible; RecoverResearch/1.0)","accept":"text/html,application/xhtml+xml"}});
    if(!r.ok)throw new Error("http "+r.status);
    const type=String(r.headers.get("content-type")||"");
    if(type&&!/html|text/i.test(type))return "";
    return (await r.text()).slice(0,1000000);
  }finally{clearTimeout(timer);}
}
function stripHtml(html=""){
  return String(html).replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ")
    .replace(/<[^>]+>/g," ").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/\s+/g," ").trim();
}
function emailsFrom(text=""){
  const blocked=/@(example\.com|sentry\.io|wixpress\.com|wordpress\.com)$/i;
  return [...new Set((String(text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig)||[]).map(x=>x.toLowerCase()).filter(x=>!blocked.test(x)))].slice(0,5);
}
function hostOf(url=""){try{return new URL(url).hostname.toLowerCase().replace(/^www\./,"");}catch{return "";}}
function linksFrom(base,html=""){
  const host=hostOf(base),out=[];
  for(const m of String(html).matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)){
    try{
      const u=new URL(m[1],base); if(!/^https?:$/.test(u.protocol)||hostOf(u.href)!==host)continue;
      if(/\b(about|attorney|lawyer|team|people|practice|contact)\b/i.test(u.pathname))out.push(u.href.split("#")[0]);
    }catch{}
  }
  return [...new Set(out)].slice(0,4);
}
function attorneyEstimate(html=""){
  const urls=[...String(html).matchAll(/href\s*=\s*["']([^"']*(?:attorney|lawyer|people|team)[^"']*)["']/gi)]
    .map(m=>m[1].replace(/[?#].*$/,"").replace(/\/$/,"")).filter(x=>x.length>3);
  const unique=[...new Set(urls)];
  const profileLike=unique.filter(x=>/(attorney|lawyer)\//i.test(x)||/\/(people|team)\/[^/]+$/i.test(x));
  return Math.min(100,profileLike.length);
}
async function duckFallback(lead){
  const q=`"${String(lead.name||"").replace(/"/g,"")}" ${lead.city||""} ${lead.region||""} email`.trim();
  if(!q)return {emails:[],text:"",source:""};
  try{
    const url="https://html.duckduckgo.com/html/?q="+encodeURIComponent(q);
    const html=await fetchText(url,6000);
    return {emails:emailsFrom(html),text:stripHtml(html).slice(0,12000),source:url};
  }catch{return {emails:[],text:"",source:""};}
}
function personalization({lead,text,practices,attorneyCount,source}){
  const city=String(lead.city||"").trim();
  if(attorneyCount>=2&&attorneyCount<=5) return {fact:`Your firm appears to have a focused team of about ${attorneyCount} attorneys`,source};
  if(attorneyCount>5) return {fact:`Your firm appears to have a team of about ${attorneyCount} attorneys`,source};
  if(practices.length&&city) return {fact:`Your firm highlights ${practices[0]} work in ${city}`,source};
  if(practices.length) return {fact:`Your firm highlights ${practices[0]} as a practice area`,source};
  const reviews=Number(lead.review_count||0),rating=Number(lead.review_rating||0);
  if(reviews>=5&&rating>0) return {fact:`I noticed your firm has ${reviews} Google reviews at about ${rating.toFixed(1)} stars`,source:String(lead.google_maps_url||"Google Maps")};
  if(city) return {fact:`I came across your firm while researching law firms in ${city}`,source:String(lead.google_maps_url||"Google Maps")};
  return {fact:"",source:""};
}
async function enrichLead(key,lead){
  if(String(lead.search_profile||"")!=="law-firm"&&normalize(lead.industry)!=="law firm")return false;
  if(await redis.sIsMember(ENRICHED_SET,key))return false;
  let emails=[...(Array.isArray(lead.emails)?lead.emails:[])], combined="",source="",attorneyCount=0;
  const website=String(lead.website||"").trim();
  if(/^https?:\/\//i.test(website)){
    try{
      const home=await fetchText(website); combined+=" "+stripHtml(home); source=website; attorneyCount=Math.max(attorneyCount,attorneyEstimate(home));
      for(const url of linksFrom(website,home).slice(0,3)){
        try{const page=await fetchText(url);combined+=" "+stripHtml(page);emails.push(...emailsFrom(page));attorneyCount=Math.max(attorneyCount,attorneyEstimate(page));if(!source)source=url;}catch{}
      }
      emails.push(...emailsFrom(home));
    }catch{}
  }
  if(!emails.length){
    const fb=await duckFallback(lead); emails.push(...fb.emails); combined+=" "+fb.text; if(!source)source=fb.source;
  }
  emails=[...new Set(emails.map(x=>String(x).toLowerCase().trim()).filter(Boolean))].slice(0,5);
  const practices=lawFirmPracticeAreas(combined+" "+[lead.category,lead.name].join(" "));
  const p=personalization({lead,text:combined,practices,attorneyCount,source});
  const preferredSize=attorneyCount>=2&&attorneyCount<=5;
  const enriched={...lead,emails,attorney_count_estimate:attorneyCount||null,preferred_firm_size:preferredSize,
    practice_areas:practices,personalization_fact:p.fact,personalization_source:p.source,
    website_opportunity:website?"has_website":"no_owned_website",law_firm_enriched_at:new Date().toISOString()};
  await redis.hSet(LEAD_HASH,key,JSON.stringify(enriched));
  await redis.sAdd(ENRICHED_SET,key);
  await redis.hIncrBy(STATS,"enriched",1);
  if(emails.length&&p.fact){
    await redis.sAdd(READY_SET,key);await redis.hIncrBy(STATS,"ready",1);
  }else if(!emails.length) await redis.hIncrBy(STATS,"missing_email",1);
  else await redis.hIncrBy(STATS,"missing_personalization",1);
  console.log(JSON.stringify({event:"law_firm_enriched",key,name:lead.name,emails:emails.length,attorneyCount:attorneyCount||null,preferredSize,practice:practices[0]||"",ready:Boolean(emails.length&&p.fact)}));
  return true;
}
async function enrichBatch(){
  let done=0;
  for await(const page of redis.hScanIterator(LEAD_HASH,{COUNT:200})){
    for(const entry of (Array.isArray(page)?page:[page])){
      if(done>=ENRICH_BATCH)return done;
      if(!entry?.field||entry.value===undefined)continue;
      let lead;try{lead=JSON.parse(entry.value)||{};}catch{continue;}
      if(await enrichLead(entry.field,lead))done++;
    }
  }
  return done;
}
async function seed(cities){
  const queue=await redis.lLen(ACTIVE_QUEUE);
  if(queue>=QUEUE_HIGH_WATER)return 0;
  const scopeCount=await redis.sCard(SCOPE_SET);
  if(scopeCount>=TARGET_TOTAL)return 0;
  let seeded=0;
  for(const area of cities){
    if(seeded>=SEED_BATCH||(await redis.lLen(ACTIVE_QUEUE))>=QUEUE_HIGH_WATER)break;
    const areaKey=area.state+"|"+normalize(area.city);
    if(await redis.sIsMember(SEEDED_SET,areaKey))continue;
    const id=randomUUID(),now=new Date().toISOString();
    const job={id,batch_id:"us-law-firm-focused-v1",industry:"LAW_FIRM",search_profile:"law-firm",location:area.location,
      partition_state:area.state,partition_city:area.city,source_population:area.population,target:20,min_score:35,
      require_phone:false,require_email:false,require_contact:true,require_no_website:false,include_no_website:true,
      max_rounds:1,depth:3,status:"queued",phase:"queued",round:0,rounds_completed:0,raw_count:0,unique_count:0,
      qualified_count:0,stored_count:0,maps_jobs:[],source:"law_firm_pipeline_v1",created_at:now,updated_at:now};
    const claim=await claimCoverage(redis,job,{source:"law_firm_pipeline_v1"});
    if(!claim.claimed){await redis.sAdd(SEEDED_SET,areaKey);continue;}
    await redis.set(`recover:acq:${id}`,JSON.stringify(job),{EX:JOB_TTL});
    await redis.sAdd("recover:acq:index",id);await redis.lPush(ACTIVE_QUEUE,id);await redis.sAdd(SEEDED_SET,areaKey);
    seeded++;
  }
  if(seeded)await redis.hIncrBy(STATS,"seeded_jobs",seeded);
  return seeded;
}

const cities=await loadCities();
console.log(JSON.stringify({event:"law_firm_pipeline_started",cities:cities.length,target:TARGET_TOTAL,queueHighWater:QUEUE_HIGH_WATER,seedBatch:SEED_BATCH,enrichBatch:ENRICH_BATCH}));
while(true){
  try{
    const [seeded,enriched]=await Promise.all([seed(cities),enrichBatch()]);
    const [queue,ready,enrichedTotal]=await Promise.all([redis.lLen(ACTIVE_QUEUE),redis.sCard(READY_SET),redis.sCard(ENRICHED_SET)]);
    console.log(JSON.stringify({event:"law_firm_pipeline_cycle",seeded,enriched,queue,ready,enrichedTotal}));
  }catch(error){console.error("law_firm_pipeline_error",error?.stack||error?.message||error);}
  await sleep(LOOP_MS);
}
