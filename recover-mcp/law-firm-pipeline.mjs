import { createClient } from "redis";
import { randomUUID } from "node:crypto";
import { lawFirmPracticeAreas, lawFirmPracticeKeys, TARGET_LAW_PRACTICES } from "./law-firm-targeting.mjs";
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
const ACTIVE_QUEUE="recover:acquisition:queue:law-firm";
const LEAD_HASH="recover:leadstore:qualified";
const SEEDED_SET="recover:law-firm:seeded:v2";
const ENRICHED_SET="recover:law-firm:enriched:v2";
const READY_SET="recover:law-firm:qualified:v2";
const REJECTED_SET="recover:law-firm:rejected:v2";
const STATS="recover:law-firm:stats:v2";
const PROFILE={industry:"LAW_FIRM",require_phone:false,require_email:false,require_contact:false,require_no_website:false,include_no_website:false,min_score:50};
const PRACTICE_FOCI=TARGET_LAW_PRACTICES.map(x=>({key:x.key,label:x.label}));
const SCOPE_SET=campaignLeadSetKey(PROFILE);

const redis=createClient({
  url:REDIS_URL,
  socket:{
    connectTimeout:10000,
    keepAlive:5000,
    reconnectStrategy:(retries)=>Math.min(5000,250*Math.max(1,retries))
  }
});
redis.on("error",e=>console.error("law-firm redis error",e));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function connectRedis(){
  let attempt=0;
  while(!redis.isReady){
    attempt++;
    try{
      if(!redis.isOpen) await redis.connect();
      if(redis.isReady) break;
    }catch(error){
      console.warn(JSON.stringify({event:"law_firm_redis_connect_retry",attempt,error:String(error?.message||error)}));
    }
    await sleep(Math.min(5000,500*attempt));
  }
}
console.log(JSON.stringify({event:"law_firm_pipeline_boot",phase:"redis_connect"}));
await connectRedis();
console.log(JSON.stringify({event:"law_firm_pipeline_boot",phase:"redis_connected"}));
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
  const started=Date.now();
  try{
    const r=await fetch(url,{signal:ctl.signal,redirect:"follow",headers:{"user-agent":"Mozilla/5.0 (compatible; RecoverResearch/1.0)","accept":"text/html,application/xhtml+xml"}});
    if(!r.ok)throw new Error("http "+r.status);
    const type=String(r.headers.get("content-type")||"");
    if(type&&!/html|text/i.test(type))return {html:"",elapsed_ms:Date.now()-started,final_url:r.url||url,status:r.status};
    return {html:(await r.text()).slice(0,1000000),elapsed_ms:Date.now()-started,final_url:r.url||url,status:r.status};
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
function attorneyEstimate(html="",text=""){
  const raw=String(html||"");
  const urls=[...raw.matchAll(/href\s*=\s*["']([^"']*(?:attorney|lawyer|people|team|our-team|professionals)[^"']*)["']/gi)]
    .map(m=>m[1].replace(/[?#].*$/,"").replace(/\/$/,"")).filter(x=>x.length>3);
  const unique=[...new Set(urls)];
  const profileLike=unique.filter(x=>/(attorney|lawyer|professional)\//i.test(x)||/\/(people|team|our-team|professionals)\/[^/]+$/i.test(x));
  let estimate=profileLike.length;

  const plain=String(text||stripHtml(raw));
  const explicit=[
    ...plain.matchAll(/\b(?:team of|our team of|firm of|more than|over)\s+(\d{1,3})\s+(?:attorneys|lawyers)\b/gi),
    ...plain.matchAll(/\b(\d{1,3})\s+(?:attorneys|lawyers)\s+(?:serving|across|with|at|in)\b/gi)
  ].map(m=>Number(m[1])).filter(n=>n>0&&n<=500);
  if(explicit.length) estimate=Math.max(estimate,Math.min(...explicit));

  const headingNames=[...raw.matchAll(/<(?:h2|h3|h4|a)[^>]*>([^<]{2,80})<\/(?:h2|h3|h4|a)>/gi)]
    .map(m=>stripHtml(m[1]).trim())
    .filter(name=>/^[A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){1,3}$/.test(name));
  const uniqueNames=[...new Set(headingNames.map(x=>x.toLowerCase()))];
  if(/\b(attorney|lawyer|our team|meet the team|professionals)\b/i.test(plain) && uniqueNames.length>=2 && uniqueNames.length<=50){
    estimate=Math.max(estimate,uniqueNames.length);
  }
  return Math.min(100,estimate);
}
async function duckFallback(lead){
  const website=String(lead.website||"").trim();
  const host=hostOf(website);
  const q=host
    ? `site:${host} "${String(lead.name||"").replace(/"/g,"")}" email contact`
    : `"${String(lead.name||"").replace(/"/g,"")}" ${lead.city||""} ${lead.region||""} email`.trim();
  if(!q)return {emails:[],text:"",source:""};
  try{
    const url="https://html.duckduckgo.com/html/?q="+encodeURIComponent(q);
    const result=await fetchText(url,6000);
    return {emails:emailsFrom(result.html),text:stripHtml(result.html).slice(0,12000),source:url};
  }catch{return {emails:[],text:"",source:""};}
}

function websiteAudit({html="",text="",url="",practiceFocus="",elapsedMs=0}={}){
  const raw=String(html||"");
  const plain=normalize(text||stripHtml(raw));
  const pain=[];
  const evidence=[];
  const add=(code,label,detail)=>{pain.push({code,label,detail});evidence.push(detail||label);};

  if(!/<meta[^>]+name=["']viewport["']/i.test(raw)) add("mobile_viewport","No mobile viewport tag detected","homepage lacks a viewport meta tag");
  if(!/<form\b/i.test(raw)) add("intake_form","No intake/contact form detected","homepage HTML contains no form element");
  if(!/href=["']tel:/i.test(raw)) add("click_to_call","No click-to-call link detected","homepage contains no tel: link");
  if(!/\b(free consultation|schedule (?:a )?consultation|request (?:a )?consultation|book (?:a )?consultation|get (?:a )?consultation|contact us|call now|get help|speak with|case evaluation)\b/i.test(plain)){
    add("consultation_cta","No strong consultation CTA detected","homepage text lacks a clear consultation/case-evaluation CTA");
  }
  if(Number(elapsedMs)>=2500) add("slow_homepage","Slow homepage response during audit",`homepage response measured about ${(Number(elapsedMs)/1000).toFixed(1)}s`);

  const focus=normalize(practiceFocus).replace(/\s+/g,"_");
  if(focus==="personal_injury"&&!/\b(case results?|settlements?|verdicts?|millions recovered|recovered for clients)\b/i.test(plain)){
    add("pi_social_proof","No case-results or settlement proof detected","homepage text lacks visible case-results/settlement proof");
  }
  if(focus==="family_divorce"&&!/\b(divorce|child custody|custody|alimony|spousal support)\b/i.test(plain)){
    add("family_service_clarity","Divorce/custody services are not obvious on the homepage","homepage text lacks clear divorce/custody terms");
  }
  if(focus==="criminal_defense"&&!/\b(24\/7|24 hours?|available now|immediate|urgent|call now|free consultation)\b/i.test(plain)){
    add("criminal_urgency","No urgent/24-7 contact signal detected","homepage lacks an obvious urgent-contact or 24/7 signal");
  }

  return {
    primary_pain_point:pain[0]?.label||"",
    pain_points:pain.slice(0,4),
    evidence:evidence.slice(0,4),
    audited_url:String(url||""),
    response_ms:Number(elapsedMs||0)
  };
}

function firmSizeTier(attorneyCount=0){
  const n=Number(attorneyCount||0);
  if(!n) return "unknown";
  if(n===1) return "solo";
  if(n>=2&&n<=10) return "preferred_2_10";
  if(n<=20) return "mid_11_20";
  return "large_21_plus";
}

function priorityScore({attorneyCount=0,reviewCount=0,hasEmail=false,painCount=0}={}){
  let score=0;
  if(attorneyCount>=2&&attorneyCount<=10) score+=30;
  else if(attorneyCount===1) score+=20;
  else if(attorneyCount>10&&attorneyCount<=20) score+=15;
  else if(!attorneyCount) score+=10;
  if(hasEmail) score+=30;
  if(painCount) score+=25;
  if(Number(reviewCount)>=10) score+=10;
  if(Number(reviewCount)>=50) score+=5;
  return Math.min(100,score);
}
function personalization({lead,text,practices,attorneyCount,source}){
  const city=String(lead.city||"").trim();
  const safeSource=String(source||lead.website||lead.google_maps_url||"").trim();
  if(practices.length&&city) return {fact:`Your firm highlights ${practices[0]} work in ${city}`,source:safeSource};
  if(practices.length) return {fact:`Your firm highlights ${practices[0]} as a practice area`,source:safeSource};
  if(attorneyCount>=2&&attorneyCount<=5) return {fact:`Your firm appears to have a focused team of about ${attorneyCount} attorneys`,source:safeSource};
  if(attorneyCount>5&&attorneyCount<=15) return {fact:`Your firm appears to have a team of about ${attorneyCount} attorneys`,source:safeSource};
  const reviews=Number(lead.review_count||0),rating=Number(lead.review_rating||0);
  if(reviews>=5&&rating>0) return {fact:`I noticed your firm has ${reviews} Google reviews at about ${rating.toFixed(1)} stars`,source:String(lead.google_maps_url||"Google Maps")};
  if(city) return {fact:`I came across your firm while researching law firms in ${city}`,source:String(lead.google_maps_url||"Google Maps")};
  return {fact:"",source:""};
}
async function enrichLead(key,lead){
  if(String(lead.search_profile||"")!=="law-firm"&&normalize(lead.industry)!=="law firm")return false;
  if(await redis.sIsMember(ENRICHED_SET,key))return false;

  const website=String(lead.website||"").trim();
  if(!/^https?:\/\//i.test(website)){
    await redis.sAdd(ENRICHED_SET,key,REJECTED_SET,key);
    await redis.hIncrBy(STATS,"rejected_no_website",1);
    return true;
  }

  let emails=[...(Array.isArray(lead.emails)?lead.emails:[])], combined="",source="",attorneyCount=0;
  let homeHtml="",homeText="",homeElapsed=0,homeUrl=website;
  try{
    const home=await fetchText(website);
    homeHtml=home.html; homeText=stripHtml(home.html); homeElapsed=home.elapsed_ms; homeUrl=home.final_url||website;
    combined+=" "+homeText; source=homeUrl;
    attorneyCount=Math.max(attorneyCount,attorneyEstimate(home.html,homeText));
    for(const url of linksFrom(homeUrl,home.html).slice(0,3)){
      try{
        const page=await fetchText(url); const pageText=stripHtml(page.html);
        combined+=" "+pageText; emails.push(...emailsFrom(page.html));
        attorneyCount=Math.max(attorneyCount,attorneyEstimate(page.html,pageText));
      }catch{}
    }
    emails.push(...emailsFrom(home.html));
  }catch{}

  if(!emails.length){
    const fb=await duckFallback({...lead,website:homeUrl||website}); emails.push(...fb.emails); combined+=" "+fb.text;
  }
  emails=[...new Set(emails.map(x=>String(x).toLowerCase().trim()).filter(Boolean))].slice(0,5);

  const practiceText=combined+" "+[lead.category,lead.name,lead.practice_focus].join(" ");
  const practices=lawFirmPracticeAreas(practiceText);
  const practiceKeys=lawFirmPracticeKeys(practiceText);
  const focus=String(lead.practice_focus||practiceKeys[0]||"").trim();
  const audit=websiteAudit({html:homeHtml,text:homeText,url:homeUrl||website,practiceFocus:focus,elapsedMs:homeElapsed});
  const p=personalization({lead,text:combined,practices,attorneyCount,source:source||homeUrl||website});
  const sizeTier=firmSizeTier(attorneyCount);
  const preferredSize=attorneyCount>=2&&attorneyCount<=10;
  const hasTargetPractice=practiceKeys.length>0;
  const qualified=Boolean(hasTargetPractice&&emails.length&&p.fact&&audit.primary_pain_point);
  const priority=priorityScore({attorneyCount,reviewCount:lead.review_count,hasEmail:emails.length>0,painCount:audit.pain_points.length});
  const emailAngle=qualified
    ? `${p.fact}. Website opportunity: ${audit.primary_pain_point}`
    : "";

  const enriched={...lead,emails,attorney_count_estimate:attorneyCount||null,preferred_firm_size:preferredSize,
    firm_size_tier:sizeTier,practice_areas:practices,practice_keys:practiceKeys,
    personalization_fact:p.fact,personalization_source:p.source,
    website_opportunity:"has_website",website_audit:audit,primary_pain_point:audit.primary_pain_point,
    email_angle:emailAngle,lead_priority_score:priority,qualified_lead:qualified,
    law_firm_enriched_at:new Date().toISOString()};

  await redis.hSet(LEAD_HASH,key,JSON.stringify(enriched));
  await redis.sAdd(ENRICHED_SET,key);
  await redis.hIncrBy(STATS,"enriched",1);
  if(qualified){
    await redis.sAdd(READY_SET,key);await redis.hIncrBy(STATS,"qualified",1);
  }else{
    await redis.sRem(READY_SET,key);await redis.sAdd(REJECTED_SET,key);
    if(!emails.length) await redis.hIncrBy(STATS,"rejected_no_email",1);
    else if(!hasTargetPractice) await redis.hIncrBy(STATS,"rejected_wrong_practice",1);
    else if(!audit.primary_pain_point) await redis.hIncrBy(STATS,"rejected_no_pain_point",1);
    else await redis.hIncrBy(STATS,"rejected_no_personalization",1);
  }
  console.log(JSON.stringify({event:"law_firm_enriched",key,name:lead.name,emails:emails.length,attorneyCount:attorneyCount||null,sizeTier,practice:practices[0]||"",painPoint:audit.primary_pain_point,qualified,priority}));
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
  const qualifiedCount=await redis.sCard(READY_SET);
  if(qualifiedCount>=TARGET_TOTAL)return 0;
  let seeded=0;
  for(const area of cities){
    for(const focus of PRACTICE_FOCI){
      if(seeded>=SEED_BATCH||(await redis.lLen(ACTIVE_QUEUE))>=QUEUE_HIGH_WATER)break;
      const areaKey=area.state+"|"+normalize(area.city)+"|"+focus.key;
      if(await redis.sIsMember(SEEDED_SET,areaKey))continue;
      const id=randomUUID(),now=new Date().toISOString();
      const job={id,batch_id:"us-law-firm-qualified-v2",industry:"LAW_FIRM",search_profile:"law-firm",practice_focus:focus.key,location:area.location,
        partition_state:area.state,partition_city:area.city,source_population:area.population,target:16,min_score:50,
        require_phone:false,require_email:false,require_contact:false,require_no_website:false,include_no_website:false,
        max_rounds:1,depth:3,status:"queued",phase:"queued",round:0,rounds_completed:0,raw_count:0,unique_count:0,
        qualified_count:0,stored_count:0,maps_jobs:[],source:"law_firm_pipeline_v2",created_at:now,updated_at:now};
      const claim=await claimCoverage(redis,job,{source:"law_firm_pipeline_v2",practice_focus:focus.key});
      if(!claim.claimed){await redis.sAdd(SEEDED_SET,areaKey);continue;}
      await redis.set(`recover:acq:${id}`,JSON.stringify(job),{EX:JOB_TTL});
      await redis.sAdd("recover:acq:index",id);await redis.lPush(ACTIVE_QUEUE,id);await redis.sAdd(SEEDED_SET,areaKey);
      seeded++;
    }
    if(seeded>=SEED_BATCH||(await redis.lLen(ACTIVE_QUEUE))>=QUEUE_HIGH_WATER)break;
  }
  if(seeded)await redis.hIncrBy(STATS,"seeded_jobs",seeded);
  return seeded;
}

console.log(JSON.stringify({event:"law_firm_pipeline_boot",phase:"city_load"}));
const cities=await loadCities();
console.log(JSON.stringify({event:"law_firm_pipeline_boot",phase:"city_loaded",cities:cities.length}));
console.log(JSON.stringify({event:"law_firm_pipeline_started",cities:cities.length,practices:PRACTICE_FOCI.map(x=>x.key),target:TARGET_TOTAL,queueHighWater:QUEUE_HIGH_WATER,seedBatch:SEED_BATCH,enrichBatch:ENRICH_BATCH}));
while(true){
  try{
    const [seeded,enriched]=await Promise.all([seed(cities),enrichBatch()]);
    const [queue,qualified,enrichedTotal,rejected]=await Promise.all([redis.lLen(ACTIVE_QUEUE),redis.sCard(READY_SET),redis.sCard(ENRICHED_SET),redis.sCard(REJECTED_SET)]);
    console.log(JSON.stringify({event:"law_firm_pipeline_cycle",seeded,enriched,queue,qualified,enrichedTotal,rejected}));
  }catch(error){console.error("law_firm_pipeline_error",error?.stack||error?.message||error);}
  await sleep(LOOP_MS);
}
