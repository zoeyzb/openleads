// deployment trigger: qualified law sheet cleanup 2026-09-28
import { createClient } from "redis";
import { randomUUID } from "node:crypto";
import { lawFirmPracticeAreas, lawFirmPracticeKeys, TARGET_LAW_PRACTICES, qualifiesNoWebsiteLawLead, shouldPauseLawDiscovery, lawResearchQueries, isUsableLawEmail } from "./law-firm-targeting.mjs";
import { campaignLeadSetKey, claimCoverage } from "./acquisition-coverage.mjs";

const REDIS_URL=process.env.ACQUISITION_REDIS_URL||process.env.REDIS_URL||"";
if(!REDIS_URL) throw new Error("ACQUISITION_REDIS_URL required");

const ZIP_SOURCE_URL=process.env.US_ZIP_SOURCE_URL||"https://raw.githubusercontent.com/ReadyAPIs-com/curated-us-zips/main/data/us-zips.csv";
const TARGET_TOTAL=Math.max(100,Number(process.env.LAW_FIRM_TARGET_TOTAL||25000));
const MAX_CITIES=Math.max(50,Number(process.env.LAW_FIRM_MAX_CITIES||1200));
const QUEUE_HIGH_WATER=Math.max(8,Math.min(64,Number(process.env.LAW_FIRM_QUEUE_HIGH_WATER||24)));
const SEED_BATCH=Math.max(1,Math.min(12,Number(process.env.LAW_FIRM_SEED_BATCH||3)));
const ENRICH_BATCH=Math.max(1,Math.min(20,Number(process.env.LAW_FIRM_ENRICH_BATCH||6)));
const ENRICH_CONCURRENCY=Math.max(1,Math.min(4,Number(process.env.LAW_FIRM_ENRICH_CONCURRENCY||3)));
const LOOP_MS=Math.max(5000,Number(process.env.LAW_FIRM_LOOP_MS||15000));
const FETCH_TIMEOUT_MS=Math.max(3000,Math.min(15000,Number(process.env.LAW_FIRM_FETCH_TIMEOUT_MS||7000)));
const JOB_TTL=Math.max(86400,Number(process.env.ACQUISITION_TTL_SECONDS||604800));
const ACTIVE_QUEUE="recover:acquisition:queue:law-firm";
const LEAD_HASH="recover:leadstore:qualified";
const SEEDED_SET="recover:law-firm:seeded:v3";
const ENRICHED_SET="recover:law-firm:enriched:v3";
const READY_SET="recover:law-firm:qualified:v3";
const REJECTED_SET="recover:law-firm:rejected:v3";
const PENDING_SET="recover:law-firm:enrich-pending:v3";
const PRIORITY_PENDING_SET="recover:law-firm:enrich-priority:v3";
const SOURCE_PENDING_SET="recover:law-firm:enrich-pending:v2";
const DISCOVERY_BACKLOG_LIMIT=Math.max(100,Number(process.env.LAW_FIRM_DISCOVERY_BACKLOG_LIMIT||1000));
const STATS="recover:law-firm:stats:v3";
const PROFILE={industry:"LAW_FIRM",require_phone:false,require_email:false,require_contact:false,require_no_website:true,include_no_website:true,min_score:45};
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
    const population=Math.max(0,Number(String(row[idx.population]||"0").replace(/[^0-9.-]/g,""))||0);
    const zip=String(row[idx.zip]||row[idx.zip_code]||row[idx.postal_code]||"").trim();
    const key=state+"|"+normalize(city);
    const prev=byCity.get(key)||{city,state,population:0,location:`${city}, ${state}`,zips:new Set()};
    // Sum ZIP population once per ZIP. This is a better city-demand proxy than
    // the old "largest ZIP wins" ranking and prioritizes real metros first.
    const zipKey=zip||("row:"+key+":"+prev.zips.size);
    if(!prev.zips.has(zipKey)){
      prev.zips.add(zipKey);
      prev.population+=population;
    }
    byCity.set(key,prev);
  }
  return [...byCity.values()]
    .map(({zips,...area})=>({...area,zip_count:zips.size}))
    .sort((a,b)=>b.population-a.population||b.zip_count-a.zip_count||a.location.localeCompare(b.location))
    .slice(0,MAX_CITIES);
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
function duckResultLinks(html=""){
  const out=[];
  for(const m of String(html).matchAll(/href=["']([^"']+)["']/gi)){
    let raw=String(m[1]||"").replace(/&amp;/g,"&");
    try{
      if(raw.startsWith("//")) raw="https:"+raw;
      const u=new URL(raw,"https://html.duckduckgo.com");
      if(/duckduckgo\.com$/i.test(u.hostname)){
        const redirected=u.searchParams.get("uddg");
        if(redirected) raw=decodeURIComponent(redirected);
        else continue;
      }
      const target=new URL(raw);
      if(!/^https?:$/.test(target.protocol))continue;
      if(/duckduckgo\.com$/i.test(target.hostname))continue;
      out.push(target.href);
    }catch{}
  }
  return [...new Set(out)].slice(0,8);
}
function specificFactFromText(text="",lead={}){
  const plain=String(text||"").replace(/\s+/g," ").trim();
  const name=String(lead.name||"the firm").trim();
  const patterns=[
    {re:/\bformer\s+(?:county\s+|state\s+|federal\s+)?prosecutor\b/i,make:()=>`${name} highlights former-prosecutor experience`},
    {re:/\bformer\s+public\s+defender\b/i,make:()=>`${name} highlights former public-defender experience`},
    {re:/\bboard[- ]certified\b/i,make:()=>`${name} highlights a board-certified attorney credential`},
    {re:/\b(?:founded|established)\s+(?:in\s+)?((?:19|20)\d{2})\b/i,make:m=>`${name} says it was established in ${m[1]}`},
    {re:/\bserving\b.{0,80}?\bsince\s+((?:19|20)\d{2})\b/i,make:m=>`${name} says it has served clients since ${m[1]}`},
    {re:/\b(\d{1,2})\+?\s+years?\s+(?:of\s+)?(?:combined\s+)?(?:legal\s+)?experience\b/i,make:m=>`${name} highlights ${m[1]}+ years of legal experience`}
  ];
  for(const p of patterns){
    const m=plain.match(p.re);
    if(m)return p.make(m);
  }
  return "";
}
async function duckFallback(lead){
  const queries=lawResearchQueries(lead);
  if(!queries.length)return {emails:[],text:"",source:"",attorneyCount:0,personalFact:"",personalFactSource:""};
  const emails=[],texts=[],sources=[];
  let attorneyCount=0,personalFact="",personalFactSource="",pageBudget=3;
  const visited=new Set();
  for(const q of queries){
    try{
      const url="https://html.duckduckgo.com/html/?q="+encodeURIComponent(q);
      const result=await fetchText(url,6000);
      const searchText=stripHtml(result.html).slice(0,9000);
      emails.push(...emailsFrom(result.html));
      texts.push(searchText);
      sources.push(url);

      for(const target of duckResultLinks(result.html)){
        if(pageBudget<=0)break;
        if(visited.has(target))continue;
        visited.add(target);pageBudget--;
        try{
          const page=await fetchText(target,6000);
          const pageText=stripHtml(page.html).slice(0,18000);
          emails.push(...emailsFrom(page.html));
          texts.push(pageText);
          const estimate=attorneyEstimate(page.html,pageText);
          if(estimate>attorneyCount)attorneyCount=estimate;
          if(!personalFact){
            const fact=specificFactFromText(pageText,lead);
            if(fact){personalFact=fact;personalFactSource=page.final_url||target;}
          }
          if(emailsFrom(page.html).length && !sources.includes(page.final_url||target)) sources.unshift(page.final_url||target);
        }catch{}
      }

      const combined=texts.join(" ");
      if(emails.length&&lawFirmPracticeKeys(combined).length&&(personalFact||pageBudget<=0))break;
    }catch{}
  }
  return {
    emails:[...new Set(emails)],
    text:texts.join(" ").slice(0,48000),
    source:sources[0]||"",
    attorneyCount,
    personalFact,
    personalFactSource
  };
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

function priorityScore({attorneyCount=0,reviewCount=0,hasEmail=false,painCount=0,personalizationQuality="none"}={}){
  let score=0;
  if(attorneyCount>=2&&attorneyCount<=10) score+=30;
  else if(attorneyCount===1) score+=20;
  else if(attorneyCount>10&&attorneyCount<=20) score+=15;
  else if(!attorneyCount) score+=10;
  if(hasEmail) score+=30;
  if(painCount) score+=20;
  if(personalizationQuality==="specific") score+=15;
  else if(personalizationQuality==="basic") score+=5;
  if(Number(reviewCount)>=10) score+=5;
  return Math.min(100,score);
}
function personalization({lead,practices,attorneyCount,source,targetLabel=""}){
  const city=String(lead.city||"").trim();
  const name=String(lead.name||"your firm").trim();
  const safeSource=String(source||lead.google_maps_url||"Google Maps").trim();
  const reviews=Number(lead.review_count||lead.reviews||0);
  const rating=Number(lead.review_rating||lead.rating||0);

  if(reviews>=5&&rating>0){
    return {
      fact:`I noticed ${name} has ${reviews} Google reviews at about ${rating.toFixed(1)} stars${city?` in ${city}`:""}`,
      source:String(lead.google_maps_url||safeSource),
      quality:"specific"
    };
  }
  if(attorneyCount>=2&&attorneyCount<=10){
    return {
      fact:`I saw that ${name} appears to have a focused team of about ${attorneyCount} attorneys${city?` in ${city}`:""}`,
      source:safeSource,
      quality:"specific"
    };
  }
  if(practices.length&&city){
    return {fact:`I came across ${name} while researching ${practices[0]} firms in ${city}`,source:safeSource,quality:"basic"};
  }
  if(targetLabel&&city){
    return {fact:`I came across ${name} while looking at ${targetLabel} firms in ${city}`,source:String(lead.google_maps_url||safeSource),quality:"basic"};
  }
  if(targetLabel){
    return {fact:`I came across ${name} while researching ${targetLabel} firms`,source:String(lead.google_maps_url||safeSource),quality:"basic"};
  }
  if(city){
    return {fact:`I came across ${name} while researching law firms in ${city}`,source:String(lead.google_maps_url||safeSource),quality:"basic"};
  }
  return {fact:"",source:"",quality:"none"};
}
async function enrichLead(key,lead){
  if(String(lead.search_profile||"")!=="law-firm"&&normalize(lead.industry)!=="law firm")return false;
  if(await redis.sIsMember(ENRICHED_SET,key))return false;

  const website=String(lead.website||"").trim();
  if(/^https?:\/\//i.test(website)){
    await redis.sAdd(ENRICHED_SET,key);
    await redis.sAdd(REJECTED_SET,key);
    await redis.hIncrBy(STATS,"rejected_has_website",1);
    return true;
  }

  let emails=[...(Array.isArray(lead.emails)?lead.emails:[])], combined="",source="",attorneyCount=0;
  const fb=await duckFallback({...lead,website:""});
  emails.push(...fb.emails);
  combined+=" "+fb.text;
  source=fb.source||String(lead.google_maps_url||"Google Maps");
  attorneyCount=Math.max(attorneyCount,Number(fb.attorneyCount||0));
  emails=[...new Set(emails.map(x=>String(x).toLowerCase().trim()).filter(isUsableLawEmail))].slice(0,5);

  const observedText=combined+" "+[lead.category,lead.name,lead.description,lead.descriptions].join(" ");
  const observedPractices=lawFirmPracticeAreas(observedText);
  const observedKeys=lawFirmPracticeKeys(observedText);
  const focus=String(lead.practice_focus||observedKeys[0]||"").trim();
  const targetPractice=TARGET_LAW_PRACTICES.find(x=>x.key===focus);
  const practices=[...new Set([...observedPractices,...(targetPractice?[targetPractice.label]:[])])];
  const practiceKeys=[...new Set([...observedKeys,...(focus?[focus]:[])])];
  const targetLabel=targetPractice?.label||practices[0]||"law";
  let p=personalization({lead,practices:observedPractices,attorneyCount,source:source||String(lead.google_maps_url||"Google Maps"),targetLabel});
  if(fb.personalFact){
    p={fact:fb.personalFact,source:fb.personalFactSource||source||String(lead.google_maps_url||"Google Maps"),quality:"specific"};
  }
  const sizeTier=firmSizeTier(attorneyCount);
  const preferredSize=attorneyCount>=2&&attorneyCount<=10;
  const painPoint="No website";
  const qualified=qualifiesNoWebsiteLawLead({website,emails,practice_keys:practiceKeys});
  const priority=priorityScore({
    attorneyCount,
    reviewCount:lead.review_count,
    hasEmail:emails.length>0,
    painCount:1,
    personalizationQuality:p.quality
  });
  const emailAngle=qualified
    ? `${p.fact||`I came across ${lead.name||"your firm"} while researching ${targetLabel} firms`}. I couldn't find a website for the firm, so I thought I'd reach out.`
    : "";

  const enriched={...lead,emails,attorney_count_estimate:attorneyCount||null,preferred_firm_size:preferredSize,
    firm_size_tier:sizeTier,practice_areas:practices,practice_keys:practiceKeys,
    lead_type:practices.join(" + "),personalization_fact:p.fact,personalization_source:p.source,
    personalization_quality:p.quality,website_opportunity:"website_build",website_audit:null,primary_pain_point:painPoint,
    target_area:String(lead.acquisition_location||[lead.city,lead.region].filter(Boolean).join(", ")||"").trim(),
    email_angle:emailAngle,lead_priority_score:priority,qualified_lead:qualified,
    law_firm_enriched_at:new Date().toISOString()};

  await redis.hSet(LEAD_HASH,key,JSON.stringify(enriched));
  await redis.sAdd(ENRICHED_SET,key);
  await redis.hIncrBy(STATS,"enriched",1);
  if(qualified){
    await redis.sAdd(READY_SET,key);
    await redis.hIncrBy(STATS,"qualified",1);
    const targetArea=String(lead.acquisition_location||[lead.city,lead.region].filter(Boolean).join(", ")||"unknown").trim();
    const practiceKey=String(focus||practiceKeys[0]||"unknown").trim();
    const day=new Date().toISOString().slice(0,10);
    await Promise.all([
      redis.hIncrBy("recover:law-firm:qualified-by-area:v3",targetArea+"|"+practiceKey,1),
      redis.hIncrBy("recover:law-firm:qualified-by-practice:v3",practiceKey,1),
      redis.hIncrBy("recover:law-firm:qualified-by-day:v3",day,1)
    ]);
  }else{
    await redis.sRem(READY_SET,key);await redis.sAdd(REJECTED_SET,key);
    if(!emails.length) await redis.hIncrBy(STATS,"rejected_no_email",1);
    else if(!practiceKeys.length) await redis.hIncrBy(STATS,"rejected_wrong_practice",1);
    else if(website) await redis.hIncrBy(STATS,"rejected_has_website",1);
  }
  console.log(JSON.stringify({event:"law_firm_enriched",key,name:lead.name,emails:emails.length,attorneyCount:attorneyCount||null,sizeTier,practice:practices[0]||"",painPoint,qualified,priority,personalizationQuality:p.quality}));
  return true;
}
async function bootstrapExistingQualified(){
  let scanned=0,qualifiedAdded=0,qualifiedRemoved=0,queuedForEnrichment=0,alreadyQualified=0;
  for await(const page of redis.hScanIterator(LEAD_HASH,{COUNT:500})){
    for(const entry of (Array.isArray(page)?page:[page])){
      if(!entry?.field||entry.value===undefined)continue;
      let lead;try{lead=JSON.parse(entry.value)||{};}catch{continue;}
      const isLaw=String(lead.search_profile||"")==="law-firm"||normalize(lead.industry)==="law firm";
      if(!isLaw)continue;
      scanned++;

      const website=String(lead.website||"").trim();
      const emails=[...(Array.isArray(lead.emails)?lead.emails:[]),lead.email]
        .map(x=>String(x||"").trim().toLowerCase())
        .filter(isUsableLawEmail);
      const evidenceText=[lead.category,lead.name,lead.description,lead.descriptions].filter(Boolean).join(" ");
      const observedKeys=lawFirmPracticeKeys(evidenceText);
      const storedKeys=Array.isArray(lead.practice_keys)?lead.practice_keys:[];
      const focus=String(lead.practice_focus||"").trim();
      const practiceKeys=[...new Set([...storedKeys,...observedKeys,...(focus?[focus]:[])])];

      const wasQualified=await redis.sIsMember(READY_SET,entry.field);
      if(!qualifiesNoWebsiteLawLead({website,emails,practice_keys:practiceKeys})){
        if(wasQualified){
          await redis.sRem(READY_SET,entry.field);
          qualifiedRemoved++;
        }
        if(!website&&emails.length&&!practiceKeys.length){
          queuedForEnrichment+=Number(await redis.sAdd(PRIORITY_PENDING_SET,entry.field)||0);
        }
        continue;
      }

      if(wasQualified){alreadyQualified++;continue;}

      const practices=[...new Set(practiceKeys.map(k=>TARGET_LAW_PRACTICES.find(p=>p.key===k)?.label).filter(Boolean))];
      const targetLabel=practices[0]||"law";
      const attorneyCount=Number(lead.attorney_count_estimate||0);
      const p=personalization({
        lead,
        practices:lawFirmPracticeAreas(evidenceText),
        attorneyCount,
        source:String(lead.personalization_source||lead.google_maps_url||"Google Maps"),
        targetLabel
      });
      const priority=priorityScore({
        attorneyCount,
        reviewCount:lead.review_count,
        hasEmail:true,
        painCount:1,
        personalizationQuality:p.quality
      });
      const personalFact=String(lead.personalization_fact||p.fact||"").trim();
      const opener=String(lead.email_angle||"").trim() ||
        `${personalFact||`I came across ${lead.name||"your firm"} while researching ${targetLabel} firms`}. I couldn't find a website for the firm, so I thought I'd reach out.`;

      const updated={
        ...lead,
        emails:[...new Set(emails)].slice(0,5),
        practice_keys:practiceKeys,
        practice_areas:practices,
        lead_type:practices.join(" + "),
        preferred_firm_size:attorneyCount>=2&&attorneyCount<=10,
        firm_size_tier:firmSizeTier(attorneyCount),
        personalization_fact:personalFact,
        personalization_source:String(lead.personalization_source||p.source||""),
        personalization_quality:String(lead.personalization_quality||p.quality||"basic"),
        website_opportunity:"website_build",
        primary_pain_point:"No website",
        email_angle:opener,
        lead_priority_score:priority,
        qualified_lead:true,
        law_firm_qualified_at:new Date().toISOString()
      };
      await redis.hSet(LEAD_HASH,entry.field,JSON.stringify(updated));
      await redis.sAdd(READY_SET,entry.field);
      await redis.hIncrBy(STATS,"qualified",1);
      qualifiedAdded++;

      if(!(await redis.sIsMember(ENRICHED_SET,entry.field))){
        queuedForEnrichment+=Number(await redis.sAdd(PENDING_SET,entry.field)||0);
      }
    }
  }
  console.log(JSON.stringify({event:"law_firm_bootstrap_existing",scanned,qualifiedAdded,qualifiedRemoved,alreadyQualified,queuedForEnrichment}));
  return {scanned,qualifiedAdded,qualifiedRemoved,alreadyQualified,queuedForEnrichment};
}

async function enrichBatch(){
  const priorityPopped=await redis.sPop(PRIORITY_PENDING_SET,ENRICH_BATCH);
  const priorityKeys=(Array.isArray(priorityPopped)?priorityPopped:[priorityPopped]).filter(Boolean);
  const remaining=Math.max(0,ENRICH_BATCH-priorityKeys.length);
  const regularPopped=remaining?await redis.sPop(PENDING_SET,remaining):[];
  const regularKeys=(Array.isArray(regularPopped)?regularPopped:[regularPopped]).filter(Boolean);
  const keys=[...new Set([...priorityKeys,...regularKeys])];
  if(!keys.length)return 0;
  let index=0,done=0;
  const run=async()=>{
    while(index<keys.length){
      const key=keys[index++];
      try{
        const raw=await redis.hGet(LEAD_HASH,key);
        if(!raw)continue;
        let lead;try{lead=JSON.parse(raw)||{};}catch{continue;}
        if(await enrichLead(key,lead))done++;
      }catch(error){
        const rawRetry=await redis.hGet(LEAD_HASH,key);
        let retryLead={};try{retryLead=rawRetry?JSON.parse(rawRetry):{};}catch{}
        const retryEmails=[...(Array.isArray(retryLead.emails)?retryLead.emails:[]),retryLead.email].filter(isUsableLawEmail);
        const retryKeys=Array.isArray(retryLead.practice_keys)?retryLead.practice_keys:[];
        await redis.sAdd(retryEmails.length&&!retryKeys.length?PRIORITY_PENDING_SET:PENDING_SET,key);
        console.warn(JSON.stringify({event:"law_firm_enrich_retry",key,error:String(error?.message||error)}));
      }
    }
  };
  await Promise.all(Array.from({length:Math.min(ENRICH_CONCURRENCY,keys.length)},()=>run()));
  return done;
}
async function seed(cities){
  const [queue,pendingV3,pendingSource]=await Promise.all([
    redis.lLen(ACTIVE_QUEUE),
    redis.sCard(PENDING_SET),
    redis.sCard(SOURCE_PENDING_SET)
  ]);
  if(queue>=QUEUE_HIGH_WATER)return 0;
  if(shouldPauseLawDiscovery({pendingEnrichment:pendingV3+pendingSource,limit:DISCOVERY_BACKLOG_LIMIT}))return 0;
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
        require_phone:false,require_email:false,require_contact:false,require_no_website:true,include_no_website:true,
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

await bootstrapExistingQualified();
console.log(JSON.stringify({event:"law_firm_pipeline_boot",phase:"city_load"}));
const cities=await loadCities();
console.log(JSON.stringify({event:"law_firm_pipeline_boot",phase:"city_loaded",cities:cities.length}));
console.log(JSON.stringify({event:"law_firm_pipeline_started",cities:cities.length,practices:PRACTICE_FOCI.map(x=>x.key),target:TARGET_TOTAL,queueHighWater:QUEUE_HIGH_WATER,seedBatch:SEED_BATCH,enrichBatch:ENRICH_BATCH,enrichConcurrency:ENRICH_CONCURRENCY,discoveryBacklogLimit:DISCOVERY_BACKLOG_LIMIT}));
while(true){
  try{
    const [seeded,enriched]=await Promise.all([seed(cities),enrichBatch()]);
    const [queue,qualified,enrichedTotal,rejected,pending]=await Promise.all([redis.lLen(ACTIVE_QUEUE),redis.sCard(READY_SET),redis.sCard(ENRICHED_SET),redis.sCard(REJECTED_SET),redis.sCard(PENDING_SET)]);
    console.log(JSON.stringify({event:"law_firm_pipeline_cycle",seeded,enriched,queue,qualified,enrichedTotal,rejected,pending}));
  }catch(error){console.error("law_firm_pipeline_error",error?.stack||error?.message||error);}
  await sleep(LOOP_MS);
}
