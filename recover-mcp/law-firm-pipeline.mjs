// deployment trigger: qualified law sheet cleanup 2026-09-28
import { createClient } from "redis";
import { randomUUID } from "node:crypto";
import { resolveMx } from "node:dns/promises";
import { orchestrate as enrichProfessionalEmail } from "email-enrich";
import { LAW_PRACTICES, lawFirmPracticeAreas, lawFirmPracticeKeys, TARGET_LAW_PRACTICES, qualifiesNoWebsiteLawLead, shouldPauseLawDiscovery, lawResearchQueries, isUsableLawEmail, isLawFirmLead } from "./law-firm-targeting.mjs";
import { campaignLeadSetKey, claimCoverage } from "./acquisition-coverage.mjs";

const REDIS_URL=process.env.ACQUISITION_REDIS_URL||process.env.REDIS_URL||"";
if(!REDIS_URL) throw new Error("ACQUISITION_REDIS_URL required");

const ZIP_SOURCE_URL=process.env.US_ZIP_SOURCE_URL||"https://raw.githubusercontent.com/ReadyAPIs-com/curated-us-zips/main/data/us-zips.csv";
const TARGET_TOTAL=Math.max(100,Number(process.env.LAW_FIRM_TARGET_TOTAL||25000));
const MAX_CITIES=Math.max(50,Number(process.env.LAW_FIRM_MAX_CITIES||1200));
const QUEUE_HIGH_WATER=Math.max(8,Math.min(64,Number(process.env.LAW_FIRM_QUEUE_HIGH_WATER||24)));
const SEED_BATCH=Math.max(1,Math.min(12,Number(process.env.LAW_FIRM_SEED_BATCH||3)));
const ENRICH_BATCH=Math.max(1,Math.min(64,Number(process.env.LAW_FIRM_ENRICH_BATCH||32)));
const ENRICH_CONCURRENCY=Math.max(1,Math.min(28,Number(process.env.LAW_FIRM_ENRICH_CONCURRENCY||12)));
const EMAIL_METHOD_VERSION="email-v35-exact-email-recovery";
const MX_CACHE=new Map();
async function hasMailExchange(email=""){
  const domain=String(email).split("@")[1]?.toLowerCase()||"";
  if(!domain)return false;
  if(MX_CACHE.has(domain))return MX_CACHE.get(domain);
  let ok=false;
  try{
    const mx=await resolveMx(domain);
    ok=Array.isArray(mx)&&mx.some(x=>String(x.exchange||"").trim());
  }catch{ok=false;}
  MX_CACHE.set(domain,ok);
  return ok;
}
async function filterContactableEmails(emails=[],lead={}){
  const unique=[...new Set(emails.map(x=>String(x||"").trim().toLowerCase()).filter(Boolean))];
  const checks=await Promise.all(unique.map(async email=>({
    email,
    ok:emailIdentityStrong(email,lead)&&await hasMailExchange(email)
  })));
  return checks.filter(x=>x.ok).map(x=>x.email);
}
async function keeleadVerifiedEmails(emails=[]){
  const unique=[...new Set(emails.map(x=>String(x||"").trim().toLowerCase()).filter(Boolean))];
  if(!unique.length)return [];
  if(!KEELEAD_BASE_URL)return unique;
  try{
    const response=await fetch(KEELEAD_BASE_URL+"/api/verify",{
      method:"POST",
      headers:{"content-type":"application/json"},
      body:JSON.stringify({emails:unique}),
      signal:AbortSignal.timeout(12000)
    });
    if(!response.ok)throw new Error("http "+response.status);
    const json=await response.json();
    const results=Array.isArray(json?.results)?json.results:[];
    const accepted=new Set(results.filter(item=>{
      const d=item?.details||{};
      return String(item?.status||"").toLowerCase()==="valid" &&
        Number(item?.score||0)>=90 &&
        d.mx===true && d.smtp===true &&
        d.disposable!==true && d.spamTrap!==true;
    }).map(item=>String(item.email||"").trim().toLowerCase()));
    return unique.filter(email=>accepted.has(email));
  }catch(error){
    await redis.hIncrBy(STATS,"email_verifier_unavailable",1);
    // KeeLead is a heuristic second opinion, not mailbox proof. Do not let a
    // helper outage erase source+identity+MX-validated emails from the pipeline.
    return unique;
  }
}
async function detectOwnedWebsiteFromEmailDomains(emails=[],lead={}){
  const domains=[...new Set(emails.map(x=>String(x||"").split("@")[1]?.toLowerCase()||"")
    .filter(d=>d&&!FREE_MAIL_DOMAINS.has(d)&&!isThirdPartyEmailDomain("x@"+d)))].slice(0,2);
  for(const domain of domains){
    for(const url of [`https://${domain}`,`https://www.${domain}`]){
      try{
        const page=await fetchResearchPage(url,lead,String(lead.place_id||lead.key||"")?("place:"+String(lead.place_id||"")):"");
        if(!page?.html)continue;
        const text=stripHtml(page.html).slice(0,24000);
        if(pageMatchesLead(text,lead)||contextHasExactPhone(text,lead)){
          return page.final_url||url;
        }
      }catch{}
    }
  }
  return "";
}
function sourceLinksToEmailDomain(html="",domain=""){
  let raw=String(html||"");
  try{raw+=" "+decodeURIComponent(raw.replace(/&amp;/g,"&"));}catch{}
  const urls=raw.match(/(?:https?:)?\/\/[a-z0-9.-]+(?::\d+)?(?:\/[^\s"'<>)]*)?/ig)||[];
  for(let value of urls){
    try{
      if(value.startsWith("//"))value="https:"+value;
      const host=new URL(value).hostname.toLowerCase().replace(/^www\./,"");
      if(host===String(domain||"").toLowerCase().replace(/^www\./,""))return true;
    }catch{}
  }
  return false;
}
async function detectOwnedWebsiteFromEvidenceSource(source="",emails=[],lead={},key=""){
  if(!isDirectPublishedEmailSource(source))return "";
  const domains=[...new Set(emails.map(x=>String(x||"").split("@")[1]?.toLowerCase()||"")
    .filter(d=>d&&!FREE_MAIL_DOMAINS.has(d)&&!isThirdPartyEmailDomain("x@"+d)))].slice(0,3);
  if(!domains.length)return "";
  try{
    const page=await fetchResearchPage(source,lead,key);
    if(!page?.html)return "";
    for(const domain of domains){
      if(sourceLinksToEmailDomain(page.html,domain))return "https://"+domain;
    }
  }catch{}
  return "";
}
async function queueWebsiteRefreshCandidate(key,lead={},website=""){
  if(!website)return;
  const candidate={...lead,website,website_opportunity:"website_refresh",website_candidate_at:new Date().toISOString()};
  await redis.hSet(WEBSITE_CANDIDATE_HASH,key,JSON.stringify(candidate));
  await redis.sAdd(WEBSITE_AUDIT_PENDING_SET,key);
}
const KEELEAD_BASE_URL=String(process.env.KEELEAD_BASE_URL||process.env.RAILWAY_SERVICE_KEELEAD_URL||"").replace(/\/$/,"");
const SCRAPLING_MCP_URL=String(process.env.SCRAPLING_MCP_URL||"").replace(/\/$/,"");
const SCRAPLING_MCP_TOKEN=String(process.env.SCRAPLING_MCP_TOKEN||"");
const JINA_READER_ENABLED=String(process.env.JINA_READER_ENABLED||"true").toLowerCase()!=="false";
const JINA_READER_RPM=Math.max(1,Math.min(18,Number(process.env.JINA_READER_RPM||18)));
const JINA_READER_MAX_INFLIGHT=Math.max(1,Math.min(3,Number(process.env.JINA_READER_MAX_INFLIGHT||3)));
const JINA_READER_CACHE=new Map();
let JINA_READER_WINDOW=[],JINA_READER_INFLIGHT=0;
const LOOP_MS=Math.max(1500,Number(process.env.LAW_FIRM_LOOP_MS||5000));
const FETCH_TIMEOUT_MS=Math.max(3000,Math.min(15000,Number(process.env.LAW_FIRM_FETCH_TIMEOUT_MS||7000)));
const JOB_TTL=Math.max(86400,Number(process.env.ACQUISITION_TTL_SECONDS||604800));
const ACTIVE_QUEUE="recover:acquisition:queue:law-firm";
const LEAD_HASH="recover:leadstore:qualified";
const SEEDED_SET="recover:law-firm:seeded:v6";
const SEED_CURSOR_KEY="recover:law-firm:seed-cursor:v7";
const SEED_WAVE_KEY="recover:law-firm:seed-wave:v7";
const ENRICHED_SET="recover:law-firm:enriched:v3";
const READY_SET="recover:law-firm:qualified:v3";
const EMAIL_CANDIDATE_SET="recover:law-firm:email-candidates:v1";
const REQUALIFY_VERSION_KEY="recover:law-firm:full-requalify-version";
const HISTORICAL_RECOVERY_VERSION_KEY="recover:law-firm:historical-recovery-version";
const HISTORICAL_QUALIFIED_KEYS=new Set(["place:ChIJ-U4jzLpzaYgRiuVOJexcUts","place:ChIJ-cZwjdl814kR3naYgZCQKWI","place:ChIJ205yYu_UyFQRWo9oRpd3T-M","place:ChIJ2ROk0Extq4kRBT2E7-tRYlw","place:ChIJ32Qgyr7wtocRGWTUwdhYGTk","place:ChIJ3QySmg_HmoARkctGxRlocHU","place:ChIJ3W-ACwxx44kR2rru4m1yG4A","place:ChIJ4W_J98Jv54gRGvAwT50QYxA","place:ChIJ4fF-dR4YhYARuNJj2qaVxFc","place:ChIJ5WPlZJCNwokRIEUL9eDQOZw","place:ChIJ5wdWFlsyMYYRWPy3nw0m03A","place:ChIJ5z3GsvfFvIcRO0k17OFS-74","place:ChIJ71pJNPiKR4gRLhF2R_ErKEk","place:ChIJ7cSewURXwokRJYKLE-zxnBw","place:ChIJ7wsutdx4bIcR6p_AksLnRyw","place:ChIJ95gGZEgg6IgRZsn5pby6rpE","place:ChIJ9zP3h5kSAIkRdWMOrKTPeI8","place:ChIJA9HEiW7rJIYR95Qpcp4Lgvg","place:ChIJAQBkSoYo3YARpPJt5RHVTWY","place:ChIJAyCOMGLOw4kR7YvAi7XZ_H4","place:ChIJBVc_u6i2hYARiPAijtV8dAY","place:ChIJD6vum6RfQogRdNScZ6vQ5Zs","place:ChIJDyWvCZZXwokRTcTR4Oj1oKQ","place:ChIJE4PSX6raxokR91IKiYlqp9k","place:ChIJF31O_YIEU4cRpSPVKS9wwtY","place:ChIJFU2oKxYzMYYRebQBKdNNm0g","place:ChIJG1VBA1HxNIgRGAJy-YLCIhI","place:ChIJGWLs2eTQhIARV7GeoY81EcE","place:ChIJH8ORLCxfVFMRiTs-1FsCUGk","place:ChIJHfJFQjomwokRSql3ngElZ5M","place:ChIJIXOHPySX-IgRBKF_bc-rke0","place:ChIJJzoh2FyGmYcRN71FnFcpY00","place:ChIJK7eQx4j5Y4gRb9qliaeIfQg","place:ChIJKYY8pmLnmoARE4mULG2YnNs","place:ChIJKer573eoZYYRC-qFdZ_Eg3A","place:ChIJKw02pnLRhIARPEIfaW4NNg0","place:ChIJLTBYQhSrw4kRMnKH-0QzcG8","place:ChIJLyxfboWMk4cRf66FH6ritxo","place:ChIJM02Gea1YXIYRyvJ5ZwPhoQw","place:ChIJM6BqOO0wq4kRTae0vIkDBVo","place:ChIJM_1lHE5ZVFMRwH1fHLVGt34","place:ChIJMbp75upAwFQRe2uTudVjsow","place:ChIJN7r7r72awoARjAesAtfbDLw","place:ChIJNycr3iOHmYcRXquelBr03KE","place:ChIJO7QVTAluAHwRVsaeyJtxK7A","place:ChIJO7lK00vF54gRQ8j3zzWyLwU","place:ChIJPRt57X_d9YgRI5UYwRJE_2U","place:ChIJQ3oMBtrRUIgR65BnUyVPft4","place:ChIJRVH9a48Tt4cR6SOOdv3Edck","place:ChIJRW1H7r3VFogRlFoHqpncZ0I","place:ChIJRYrj7X3pwogRdG_E9PJYcf0","place:ChIJTa7FEGNQ4IYRSydBoKqsl2o","place:ChIJUYXwNCnaNYgRjAdaoH_ogLw","place:ChIJVYdWQ-4Cw4kRr4bAd6NLQVY","place:ChIJVxw7O9jeJIgR1FiEkRQhZLI","place:ChIJY6aHQLRcfYcRKiqiFK5w0do","place:ChIJayky0_XFvIcRjdDZMkHLRD8","place:ChIJb2hcRZsU3okR_EKIIlGOyw8","place:ChIJb3hWSBZv_4gROY_ApeSM8wU","place:ChIJbxKvvzbu2YkRMdteRtp7klE","place:ChIJd1aP8_KVlocR8_cIhc_Dsd0","place:ChIJdTzQCQJ5hYARdGR1UtB9dkE","place:ChIJeXm0tUXM3IARGzqfb3eOmCY","place:ChIJf2DHHpm3D4gRXfghePyBLmk","place:ChIJfyFrYXdVwIcRYhnjhZT1owA","place:ChIJgx6wDyjpaIgRAC-jEra5Hjw","place:ChIJi87TdvdvwokRjr-8f8K3FG0","place:ChIJjcnM45EgnYgREsRlrRsiyGg","place:ChIJkTUAzFFwzoARxKluSnPRdWQ","place:ChIJl6VxtjJBZIgRBc4VIABoDiw","place:ChIJmbFHSgiQhYAR0v11xfpj4bw","place:ChIJn5Qcag_1UocRtfKl2ZxDBug","place:ChIJnQ8ijF_v44kRFNChrD1otkQ","place:ChIJo-hS02IU7IARMFpv8tr4RTY","place:ChIJpWJorhCs0IkRRcYffMNkoeI","place:ChIJqSz5ytfMwoARZvRZn84vWmI","place:ChIJr104108HYIgRkJT9GlF7xKw","place:ChIJs4frIbQakFQRQPUW66WTiH4","place:ChIJsRDfI5BBZIgR4v0gkMlYNgA","place:ChIJsewYiPRp6oAR6fKhe5QIWcY","place:ChIJt4aEWsHfyFYRT_jYSgVRVw4","place:ChIJt9fh31NZ54YR5ZyCFBn9ock","place:ChIJtRjaRPXgtYcR2V6WyoGvW6g","place:ChIJuzD2vZYT2YkR7dqgvdWC6DY","place:ChIJxUWzCxINkIARDdm6uFNIS-E","place:ChIJzWyZs58FU4gR5-_YQva8wr4"]);
const REJECTED_SET="recover:law-firm:rejected:v3";
const PENDING_SET="recover:law-firm:enrich-pending:v3";
const SIZE_READY_PENDING_SET="recover:law-firm:size-ready-pending:v1";
const PRIORITY_PENDING_SET="recover:law-firm:enrich-priority:v3";
const RECOVERABLE_PENDING_SET="recover:law-firm:enrich-recoverable:v1";
const SOURCE_PENDING_SET="recover:law-firm:enrich-pending:v2";
const WEBSITE_CANDIDATE_HASH="recover:law-firm:website-candidates:v1";
const WEBSITE_AUDIT_PENDING_SET="recover:law-firm:website-audit-pending:v1";
const WEBSITE_REFRESH_HASH="recover:law-firm:website-refresh:v1";
const WEBSITE_REFRESH_READY_SET="recover:law-firm:website-refresh-ready:v1";
const WEBSITE_REFRESH_REJECTED_SET="recover:law-firm:website-refresh-rejected:v1";
const WEBSITE_REFRESH_EMAIL_INDEX="recover:law-firm:website-refresh-email-index:v1";
const WEBSITE_REFRESH_DOMAIN_INDEX="recover:law-firm:website-refresh-domain-index:v1";
const WEBSITE_AUDIT_BATCH=Math.max(1,Math.min(32,Number(process.env.LAW_WEBSITE_AUDIT_BATCH||20)));
const WEBSITE_AUDIT_CONCURRENCY=Math.max(1,Math.min(12,Number(process.env.LAW_WEBSITE_AUDIT_CONCURRENCY||8)));
const DISCOVERY_BACKLOG_LIMIT=Math.max(1000,Number(process.env.LAW_FIRM_DISCOVERY_BACKLOG_LIMIT||15000));
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
function lawFirmNameShape(lead={}){
  const name=String(lead.name||lead.title||"").replace(/\s+/g," ").trim();
  if(!name)return "unknown";
  if(/\b(?:attorneys at law|attorneys|lawyers|partners|associates|law group|legal group)\b/i.test(name)||
     /\s(?:&|and)\s/i.test(name))return "multi";
  if(/\b(?:law firm|pllc|p\.c\.|pc|p\.a\.|pa|llp|professional corporation)\b/i.test(name))return "firm";
  if(/^the?\s*law office of\s+[A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){1,4}$/i.test(name)||
     /\battorney(?:\s+at\s+law)?\b/i.test(name)||
     /^[A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){1,3}(?:,?\s+Esq\.?)?$/i.test(name))return "solo";
  return "unknown";
}
function highValueLawResearchLead(lead={}){
  const shape=lawFirmNameShape(lead), score=emailRecoveryPriority(lead);
  return score>=5||((shape==="multi"||shape==="firm")&&score>=4);
}
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
  const all=[...byCity.values()]
    .map(({zips,...area})=>({...area,zip_count:zips.size}))
    .filter(area=>area.population>=5000);

  // No-website law firms are disproportionately more likely outside the
  // largest metros. Build a state-diverse frontier that favors small/mid
  // cities without abandoning major markets.
  const bands={
    small:all.filter(x=>x.population>=5000&&x.population<50000),
    mid:all.filter(x=>x.population>=50000&&x.population<200000),
    large:all.filter(x=>x.population>=200000&&x.population<750000),
    mega:all.filter(x=>x.population>=750000)
  };
  for(const rows of Object.values(bands)){
    rows.sort((a,b)=>a.state.localeCompare(b.state)||b.population-a.population||a.location.localeCompare(b.location));
  }
  const stateRoundRobin=(rows)=>{
    const byState=new Map();
    for(const row of rows){
      if(!byState.has(row.state))byState.set(row.state,[]);
      byState.get(row.state).push(row);
    }
    const states=[...byState.keys()].sort();
    const out=[];
    let remaining=true;
    while(remaining){
      remaining=false;
      for(const state of states){
        const row=byState.get(state)?.shift();
        if(row){out.push(row);remaining=true;}
      }
    }
    return out;
  };
  const small=stateRoundRobin(bands.small), mid=stateRoundRobin(bands.mid),
    large=stateRoundRobin(bands.large), mega=stateRoundRobin(bands.mega);
  const cursors={small:0,mid:0,large:0,mega:0}, result=[];
  // 50% small, 30% mid, 15% large, 5% mega per 20 slots.
  const pattern=["small","mid","small","large","small","mid","small","mega",
    "mid","small","large","small","mid","small","small","mid",
    "large","small","mid","small"];
  while(result.length<MAX_CITIES){
    let progressed=false;
    for(const band of pattern){
      const rows={small,mid,large,mega}[band];
      const idx=cursors[band];
      if(idx<rows.length){
        result.push(rows[idx]);
        cursors[band]=idx+1;
        progressed=true;
        if(result.length>=MAX_CITIES)break;
      }
    }
    if(!progressed)break;
  }
  return result;
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
function parseRemoteMcpPayload(text=""){
  try{return JSON.parse(text);}catch{}
  const lines=String(text).split("\n").filter(line=>line.startsWith("data:"));
  for(const line of lines.reverse()){
    try{return JSON.parse(line.slice(5).trim());}catch{}
  }
  return {raw:text};
}
async function callScrapling(url){
  if(!SCRAPLING_MCP_URL||!url)return null;
  const headers={"content-type":"application/json","accept":"application/json, text/event-stream"};
  if(SCRAPLING_MCP_TOKEN)headers.authorization=`Bearer ${SCRAPLING_MCP_TOKEN}`;
  const initCtl=new AbortController(), initTimer=setTimeout(()=>initCtl.abort(),8000);
  try{
    const initRes=await fetch(SCRAPLING_MCP_URL,{
      method:"POST",headers,signal:initCtl.signal,
      body:JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{protocolVersion:"2025-03-26",capabilities:{},clientInfo:{name:"recover-law-controller",version:"1.0"}}})
    });
    const initText=await initRes.text();
    if(!initRes.ok)throw new Error("initialize "+initRes.status+" "+initText.slice(0,120));
    const sessionHeaders={...headers};
    const sessionId=initRes.headers.get("mcp-session-id");
    if(sessionId)sessionHeaders["mcp-session-id"]=sessionId;
    await fetch(SCRAPLING_MCP_URL,{method:"POST",headers:sessionHeaders,body:JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"}),signal:AbortSignal.timeout(4000)});
    const callRes=await fetch(SCRAPLING_MCP_URL,{
      method:"POST",headers:sessionHeaders,signal:AbortSignal.timeout(12000),
      body:JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"stealthy_fetch",arguments:{url,ai_targeted:false,headless:true,network_idle:false}}})
    });
    const payload=parseRemoteMcpPayload(await callRes.text());
    if(!callRes.ok)throw new Error("call "+callRes.status);
    const structured=payload?.result?.structuredContent||{};
    let content=structured?.content;
    if(!content){
      const rawText=payload?.result?.content?.[0]?.text;
      if(rawText){try{content=JSON.parse(rawText)?.content;}catch{}}
    }
    const text=Array.isArray(content)?content.filter(Boolean).join("\n"):String(content||"");
    if(!text.trim())return null;
    await redis.hIncrBy(STATS,"scrapling_source_hit",1);
    return {html:text.slice(0,1000000),elapsed_ms:0,final_url:String(structured?.url||url),status:Number(structured?.status||200),via:"scrapling"};
  }catch(error){
    const failures=await redis.hIncrBy(STATS,"scrapling_source_fail",1);
    if(failures<=3||failures%100===0)console.warn(JSON.stringify({event:"law_scrapling_fail",failures,error:String(error?.message||error).slice(0,220)}));
    return null;
  }finally{clearTimeout(initTimer);}
}
async function callJinaReader(url,lead={}){
  if(!JINA_READER_ENABLED||!url||lawSourceRank(url,lead)>4)return null;
  const cached=JINA_READER_CACHE.get(url);
  if(cached&&Date.now()-cached.at<30*60*1000)return cached.value;

  const now=Date.now();
  JINA_READER_WINDOW=JINA_READER_WINDOW.filter(ts=>now-ts<60000);
  if(JINA_READER_WINDOW.length>=JINA_READER_RPM||JINA_READER_INFLIGHT>=JINA_READER_MAX_INFLIGHT)return null;
  JINA_READER_WINDOW.push(now);
  JINA_READER_INFLIGHT++;
  try{
    const target="https://r.jina.ai/"+String(url);
    const response=await fetch(target,{
      headers:{
        "accept":"text/plain",
        "x-engine":"browser",
        "x-return-format":"markdown",
        "user-agent":"RecoverLawResearch/1.0"
      },
      signal:AbortSignal.timeout(15000)
    });
    if(!response.ok)throw new Error("http "+response.status);
    const text=(await response.text()).slice(0,1000000);
    if(!text.trim())return null;
    const value={html:text,elapsed_ms:0,final_url:String(url),status:200,via:"jina"};
    JINA_READER_CACHE.set(url,{at:Date.now(),value});
    if(JINA_READER_CACHE.size>500){
      const first=JINA_READER_CACHE.keys().next().value;
      if(first)JINA_READER_CACHE.delete(first);
    }
    await redis.hIncrBy(STATS,"jina_source_hit",1);
    return value;
  }catch(error){
    await redis.hIncrBy(STATS,"jina_source_fail",1);
    JINA_READER_CACHE.set(url,{at:Date.now(),value:null});
    return null;
  }finally{
    JINA_READER_INFLIGHT=Math.max(0,JINA_READER_INFLIGHT-1);
  }
}
async function fetchResearchPage(url,lead={},key="",allowStealth=true){
  let direct=null;
  try{direct=await fetchText(url,4500);}catch{}
  const directText=direct?.html?stripHtml(direct.html).slice(0,24000):"";
  const directMatches=Boolean(direct?.html&&pageMatchesLead(directText,lead));
  const directEvidence=directMatches&&(
    contextualEmails(direct.html,lead,url).length>0 ||
    attorneyEstimate(direct.html,directText)>0
  );
  if(directEvidence)return direct;
  const shouldDeepRead=HISTORICAL_QUALIFIED_KEYS.has(key)||highValueLawResearchLead(lead);
  if(allowStealth&&shouldDeepRead){
    const jina=await callJinaReader(url,lead);
    if(jina?.html){
      const jinaText=stripHtml(jina.html).slice(0,24000);
      if(pageMatchesLead(jinaText,lead))return jina;
    }
    const stealth=await callScrapling(url);
    if(stealth?.html){
      const stealthText=stripHtml(stealth.html).slice(0,24000);
      if(pageMatchesLead(stealthText,lead))return stealth;
    }
  }
  return directMatches?direct:null;
}
function stripHtml(html=""){
  return String(html).replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ")
    .replace(/<[^>]+>/g," ").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/\s+/g," ").trim();
}
function emailsFrom(text=""){
  let source=String(text||"");
  try{source=decodeURIComponent(source.replace(/\+/g,"%20"));}catch{}
  source=source
    .replace(/&#64;|&commat;/gi,"@")
    .replace(/&#46;|&period;/gi,".")
    .replace(/\s*(?:\[at\]|\(at\)|\{at\})\s*/gi,"@")
    .replace(/\s+(?:at)\s+/gi,"@")
    .replace(/\s*(?:\[dot\]|\(dot\)|\{dot\})\s*/gi,".")
    .replace(/\s+(?:dot)\s+/gi,".");
  return [...new Set((source.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig)||[])
    .map(x=>x.toLowerCase().replace(/[),.;:]+$/,""))
    .filter(isUsableLawEmail))].slice(0,8);
}
function likelyAttorneyName(lead={}){
  const explicit=String(lead.owner_name||"").replace(/\s+/g," ").trim();
  if(explicit&&explicit.split(/\s+/).length>=2)return explicit;
  const raw=String(lead.name||lead.title||"").replace(/\s+/g," ").trim();
  if(!raw)return "";
  const patterns=[
    /law offices? of\s+([A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){1,4})/i,
    /^attorney\s+([A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){1,4})/i,
    /^([A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){1,4})\s+law offices?\b/i,
    /^([A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){1,4})\s+attorney(?:\s+at\s+law)?\b/i,
    /(?:attorney|lawyer)(?:\s+at\s+law)?\s+([A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){1,4})/i,
    /^([A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){1,3}),?\s+(?:esq\.?|attorney(?:\s+at\s+law)?)$/i,
    /^([A-Z][A-Za-z.'’-]+\s+[A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+)?)$/i
  ];
  for(const re of patterns){
    const m=raw.match(re);
    if(m?.[1]){
      const name=String(m[1]).replace(/\b(?:LLC|PLLC|PC|PA|Esq)\.?$/i,"").trim();
      if(name.split(/\s+/).length>=2)return name;
    }
  }
  return "";
}
function attorneyNameVariants(lead={}){
  const primary=likelyAttorneyName(lead);
  if(!primary)return [];
  const values=[primary];
  const parts=primary.replace(/,/g," ").split(/\s+/).filter(Boolean);
  const suffixes=new Set(["jr","sr","ii","iii","iv","esq"]);
  if(parts.length>=2&&parts.length<=4){
    const clean=parts.filter(x=>!suffixes.has(x.toLowerCase().replace(/\./g,"")));
    if(clean.length>=2){
      // Maps frequently stores attorneys as "Last First M". Search both forms.
      values.push([clean[1],...clean.slice(2),clean[0]].join(" "));
      values.push([clean[clean.length-1],...clean.slice(1,-1),clean[0]].join(" "));
    }
  }
  return [...new Set(values.map(x=>x.replace(/\s+/g," ").trim()).filter(x=>x.split(/\s+/).length>=2))].slice(0,3);
}
async function zeroCostEmailFallback(lead={}){
  const names=attorneyNameVariants(lead).slice(0,3);
  if(!names.length)return {emails:[],source:"",name_variant:""};
  const attempts=await Promise.allSettled(names.map(async personName=>{
    const result=await enrichProfessionalEmail("recover-law-email-v5",{
      person_name:personName,
      company_name:String(lead.name||lead.title||personName),
      mode:"fast",
      real_only:true,
      use_case:"cold_outreach",
      hints:{source_urls:[String(lead.google_maps_url||"")].filter(Boolean)}
    });
    const published=(result?.evidence?.found_public_emails||[])
      .map(x=>String(x||"").trim().toLowerCase())
      .filter(x=>isUsableLawEmail(x)&&!FREE_MAIL_DOMAINS.has(String(x).split("@")[1]||"")&&emailLooksOwnedByLead(x,lead));
    const best=String(result?.best_email||"").trim().toLowerCase();
    const accepted=best&&published.includes(best)&&Number(result?.confidence||0)>=0.9?[best]:[];
    return {emails:accepted,source:String(result?.evidence?.sources_checked?.[0]||""),name_variant:personName};
  }));
  for(const attempt of attempts){
    if(attempt.status==="fulfilled"&&attempt.value.emails.length)return attempt.value;
  }
  return {emails:[],source:"",name_variant:""};
}
function leadNameTokens(lead={}){
  const stop=new Set(["law","laws","firm","firms","office","offices","attorney","attorneys","lawyer","lawyers","llc","pllc","pc","pa","group","associates","the","and"]);
  return normalize(lead.name||lead.title||"").split(" ").filter(x=>x.length>=3&&!stop.has(x)).slice(0,6);
}
function pageMatchesLead(text="",lead={}){
  const plain=normalize(text);
  if(!plain)return false;
  const phone=String(lead.phone||"").replace(/\D/g,"").slice(-10);
  if(phone&&String(text).replace(/\D/g,"").includes(phone))return true;
  const fullName=normalize(lead.name||lead.title||"");
  if(fullName.length>=8&&plain.includes(fullName))return true;
  const person=likelyAttorneyName(lead);
  const personTokens=person?normalize(person).split(" ").filter(x=>x.length>=3):[];
  if(personTokens.length>=2&&personTokens.filter(x=>plain.includes(x)).length>=2)return true;
  const tokens=leadNameTokens(lead);
  if(tokens.length<2)return false;
  const hits=tokens.filter(x=>plain.includes(x)).length;
  return hits>=2;
}
const FREE_MAIL_DOMAINS=new Set([
  "gmail.com","yahoo.com","hotmail.com","outlook.com","aol.com","icloud.com","me.com","msn.com",
  "proton.me","protonmail.com","live.com","comcast.net","att.net","bellsouth.net","verizon.net",
  "sbcglobal.net","earthlink.net","cs.com","vcn.com"
]);

const GENERIC_EMAIL_LOCAL=new Set(["info","contact","office","admin","hello","support","mail","reception","receptionist","intake","legal","law","team","general","marketing"]);
function emailContactRank(email=""){
  const value=String(email||"").toLowerCase().trim();
  const local=value.split("@")[0]||"";
  if(!value)return 99;
  if(GENERIC_EMAIL_LOCAL.has(local))return 5;
  if(/^(info|contact|office|admin|hello|support|mail|reception|intake|legal|law|team|general|marketing)[._+-]/.test(local))return 4;
  if(/^[a-z][a-z0-9.'_-]{2,}$/.test(local))return 1;
  return 3;
}
function rankLawEmails(values=[]){
  return [...new Set(values.map(x=>String(x||"").toLowerCase().trim()).filter(Boolean))]
    .sort((a,b)=>emailContactRank(a)-emailContactRank(b)||a.localeCompare(b));
}
const THIRD_PARTY_EMAIL_DOMAINS=[
  "reachattorneys.com","birdeye.com","avvo.com","findlaw.com","lawyers.com","justia.com",
  "martindale.com","superlawyers.com","yellowpages.com","yelp.com","facebook.com","linkedin.com"
];
function isThirdPartyEmailDomain(email=""){
  const domain=String(email).split("@")[1]?.toLowerCase()||"";
  return THIRD_PARTY_EMAIL_DOMAINS.some(d=>domain===d||domain.endsWith("."+d));
}
function tokenAffinity(haystack="",token=""){
  const h=String(haystack||"").replace(/[^a-z0-9]/g,"");
  const t=String(token||"").replace(/[^a-z0-9]/g,"");
  if(t.length<3||!h)return false;
  const base=t.endsWith("s")&&t.length>4?t.slice(0,-1):t;
  return h.includes(t)||t.includes(h)||(base.length>=3&&(h.includes(base)||base.includes(h)));
}

const US_STATE_NAMES={
  AL:"alabama",AK:"alaska",AZ:"arizona",AR:"arkansas",CA:"california",CO:"colorado",CT:"connecticut",DE:"delaware",FL:"florida",GA:"georgia",HI:"hawaii",ID:"idaho",IL:"illinois",IN:"indiana",IA:"iowa",KS:"kansas",KY:"kentucky",LA:"louisiana",ME:"maine",MD:"maryland",MA:"massachusetts",MI:"michigan",MN:"minnesota",MS:"mississippi",MO:"missouri",MT:"montana",NE:"nebraska",NV:"nevada",NH:"newhampshire",NJ:"newjersey",NM:"newmexico",NY:"newyork",NC:"northcarolina",ND:"northdakota",OH:"ohio",OK:"oklahoma",OR:"oregon",PA:"pennsylvania",RI:"rhodeisland",SC:"southcarolina",SD:"southdakota",TN:"tennessee",TX:"texas",UT:"utah",VT:"vermont",VA:"virginia",WA:"washington",WV:"westvirginia",WI:"wisconsin",WY:"wyoming"
};
const FOREIGN_CCTLD_RE=/\.(?:ca|uk|au|nz|ie|in|pk|za|de|fr|it|es|mx|br|sg|hk|jp|cn|ru)$/i;
function emailDomainStateMismatch(email="",lead={}){
  const domain=String(email).split("@")[1]?.toLowerCase().replace(/[^a-z0-9.]/g,"")||"";
  const state=String(lead.region||lead.state||lead.state_code||"").trim().toUpperCase();
  if(!domain||!state)return false;
  const stem=domain.replace(/[^a-z0-9]/g,"");
  const expected=US_STATE_NAMES[state]||"";
  for(const [code,name] of Object.entries(US_STATE_NAMES)){
    if(code===state)continue;
    if(name.length>=5&&stem.includes(name))return true;
  }
  return false;
}
function emailDomainGeographySafe(email="",lead={}){
  const domain=String(email).split("@")[1]?.toLowerCase()||"";
  const state=String(lead.region||lead.state||lead.state_code||"").trim().toUpperCase();
  if(!domain)return false;
  if(state&&FOREIGN_CCTLD_RE.test(domain))return false;
  if(emailDomainStateMismatch(email,lead))return false;
  return true;
}
function emailLooksOwnedByLead(email="",lead={}){
  const domain=String(email).split("@")[1]?.toLowerCase()||"";
  if(!domain||isThirdPartyEmailDomain(email)||FREE_MAIL_DOMAINS.has(domain)||!emailDomainGeographySafe(email,lead))return false;
  const stem=domain.split(".")[0].replace(/[^a-z0-9]/g,"");
  const local=String(email).split("@")[0]?.toLowerCase().replace(/[^a-z0-9]/g,"")||"";
  const tokens=leadNameTokens(lead).map(x=>x.replace(/[^a-z0-9]/g,"")).filter(x=>x.length>=3);
  const domainHits=tokens.filter(t=>tokenAffinity(stem,t)).length;
  const localHits=tokens.filter(t=>local.length>=3&&tokenAffinity(local,t)).length;
  const legalMarker=/law|legal|attorney|lawyer|firm|office|esq/.test(stem);
  // Avoid generic corporate/surname domains: require either two business-name
  // tokens, a law-specific domain marker, or independent local-part identity.
  return domainHits>=2||(domainHits>=1&&legalMarker)||(domainHits>=1&&localHits>=1);
}
function emailIdentityStrong(email="",lead={}){
  if(!isUsableLawEmail(email)||isThirdPartyEmailDomain(email)||!emailDomainGeographySafe(email,lead))return false;
  const domain=String(email).split("@")[1]?.toLowerCase()||"";
  if(!FREE_MAIL_DOMAINS.has(domain))return emailLooksOwnedByLead(email,lead);
  const local=String(email).split("@")[0]?.toLowerCase().replace(/[^a-z0-9]/g,"")||"";
  const tokens=leadNameTokens(lead).map(x=>x.replace(/[^a-z0-9]/g,"")).filter(x=>x.length>=3);
  const person=likelyAttorneyName(lead);
  const personTokens=person?normalize(person).split(" ").map(x=>x.replace(/[^a-z0-9]/g,"")).filter(x=>x.length>=3):[];
  const firmHits=tokens.filter(t=>tokenAffinity(local,t)).length;
  const personHits=personTokens.filter(t=>tokenAffinity(local,t)).length;
  return personHits>=1||(firmHits>=1&&(firmHits>=2||tokens.length<=2||/(law|esq|attorney)/.test(local)));
}
function exactIdentityNearEmail(context="",lead={}){
  const plain=normalize(context);
  const person=likelyAttorneyName(lead);
  const personTokens=person?normalize(person).split(" ").filter(x=>x.length>=3):[];
  const leadTokens=leadNameTokens(lead).filter(x=>x.length>=4);
  const personHits=personTokens.length>=2&&personTokens.filter(t=>plain.includes(t)).length>=2;
  const firmHits=leadTokens.length>=2&&leadTokens.filter(t=>plain.includes(t)).length>=Math.min(2,leadTokens.length);
  return personHits||firmHits;
}
function contextHasExactPhone(text="",lead={}){
  const phone=String(lead.phone||"").replace(/\D/g,"").slice(-10);
  return !!(phone&&String(text).replace(/\D/g,"").includes(phone));
}
function contextualEmails(text="",lead={},sourceUrl=""){
  const raw=String(text||""),out=[];
  const re=/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
  const all=[...raw.matchAll(re)]
    .map(m=>({email:String(m[0]||"").toLowerCase().replace(/[),.;:]+$/,""),index:m.index||0}))
    .filter(x=>isUsableLawEmail(x.email)&&!isThirdPartyEmailDomain(x.email));
  const uniqueAll=[...new Set(all.map(x=>x.email))];
  const fullPageMatch=pageMatchesLead(raw,lead);
  const fullPhoneMatch=contextHasExactPhone(raw,lead);
  const trustedSource=trustedLawSource(sourceUrl,lead);

  for(const m of all){
    const start=Math.max(0,m.index-900),end=Math.min(raw.length,m.index+m.email.length+900);
    const context=raw.slice(start,end);
    const nearbyIdentity=pageMatchesLead(context,lead);
    const nearbyPhone=contextHasExactPhone(context,lead);
    const domain=String(m.email).split("@")[1]?.toLowerCase()||"";
    const freeMail=FREE_MAIL_DOMAINS.has(domain);
    const exactNearby=exactIdentityNearEmail(context,lead);
    if(nearbyPhone&&nearbyIdentity){
      out.push(m.email);continue;
    }
    if(!freeMail&&nearbyIdentity&&emailLooksOwnedByLead(m.email,lead)){
      out.push(m.email);continue;
    }
    if(freeMail&&exactNearby&&(nearbyPhone||fullPhoneMatch||trustedSource)){
      out.push(m.email);continue;
    }
    // For split-layout bar/court profiles, require exact whole-page phone AND
    // either firm-domain affinity or an exact attorney/firm identity match.
    if(fullPageMatch&&uniqueAll.length<=3&&
      ((!freeMail&&fullPhoneMatch&&emailLooksOwnedByLead(m.email,lead))||
       (freeMail&&exactIdentityNearEmail(raw,lead)&&(fullPhoneMatch||trustedSource)))){
      out.push(m.email);
    }
  }
  return [...new Set(out)].slice(0,8);
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
  const plain=String(text||stripHtml(String(html||""))).replace(/\s+/g," ").trim();
  if(!plain)return 0;

  // Only explicit numerical firm-size evidence is allowed to qualify 2-10.
  // Never count unrelated profile links/headings on directory/search pages.
  const exact=[
    ...plain.matchAll(/\b(?:team of|our team of|firm of)\s+(\d{1,3})\s+(?:attorneys|lawyers)\b/gi),
    ...plain.matchAll(/\b(?:number of attorneys|attorney count|number of lawyers|lawyer count)\s*[:#-]?\s*(\d{1,3})\b/gi),
    ...plain.matchAll(/\b(?:attorneys|lawyers)\s*\(\s*(\d{1,3})\s*\)/gi),
    ...plain.matchAll(/\bfirm\s+size\s*:?\s*(\d{1,3})\s+(?:attorneys|lawyers)?\b/gi)
  ].map(m=>Number(m[1])).filter(n=>n>0&&n<=500);

  const ranges=[...plain.matchAll(/\bfirm\s+size\s*:?\s*(\d{1,2})\s*(?:to|[-–])\s*(\d{1,2})\b/gi)]
    .map(m=>[Number(m[1]),Number(m[2])])
    .filter(([lo,hi])=>lo>0&&hi>=lo&&hi<=100);

  const candidates=[...exact];
  for(const [lo,hi] of ranges){
    // A 1-5 bucket is not enough to prove the firm has at least 2 attorneys.
    candidates.push(lo>=2?hi:1);
  }
  if(/\bfirm\s+size\s*:?\s*solo\b/i.test(plain))candidates.push(1);
  if(!candidates.length)return 0;

  // Be conservative across conflicting explicit evidence: use the largest count,
  // so any 11+ evidence prevents an accidental 2-10 qualification.
  return Math.min(500,Math.max(...candidates));
}
function decodeBingRedirect(raw=""){
  try{
    const url=new URL(String(raw||"").replace(/&amp;/g,"&"));
    if(!/(^|\.)bing\.com$/i.test(url.hostname))return url.href;
    if(!/\/ck\/a/i.test(url.pathname))return "";
    let target=String(url.searchParams.get("u")||url.searchParams.get("url")||"");
    if(!target)return "";
    target=decodeURIComponent(target);
    if(target.startsWith("a1")){
      const encoded=target.slice(2).replace(/-/g,"+").replace(/_/g,"/");
      try{target=Buffer.from(encoded,"base64").toString("utf8");}catch{}
    }
    if(!/^https?:\/\//i.test(target))return "";
    return new URL(target).href;
  }catch{return "";}
}
function markdownResultLinks(text=""){
  const out=[];
  for(const m of String(text||"").matchAll(/\[[^\]]{1,240}\]\((https?:\/\/[^)\s]+)\)/g)){
    try{
      const u=new URL(m[1]);
      if(/(^|\.)(bing|google|duckduckgo)\.com$/i.test(u.hostname))continue;
      out.push(u.href);
    }catch{}
  }
  return [...new Set(out)].slice(0,16);
}
function bingResultLinks(html=""){
  const out=[];
  for(const m of String(html).matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)){
    const decoded=decodeBingRedirect(m[1]);
    if(!decoded)continue;
    try{
      const u=new URL(decoded);
      if(/(^|\.)bing\.com$/i.test(u.hostname))continue;
      if(!/^https?:$/.test(u.protocol))continue;
      out.push(u.href);
    }catch{}
  }
  return [...new Set(out)].slice(0,12);
}
async function bingFallback(lead,query,pageBudget=6,key="",wantedEmails=[]){
  const emails=[],texts=[],sources=[];
  let attorneyCount=0,attorneyCountSource="",personalFact="",personalFactSource="";
  const queries=[...new Set((Array.isArray(query)?query:[query]).map(x=>String(x||"").trim()).filter(Boolean))].slice(0,6);
  try{
    const searchResults=await Promise.allSettled(queries.map(async (q,searchIndex)=>{
      const url="https://www.bing.com/search?q="+encodeURIComponent(q);
      let result=null;
      try{result=await fetchText(url,5000);}catch{}
      let resultLinks=result?.html?bingResultLinks(result.html):[];
      if(!resultLinks.length&&searchIndex===0&&highValueLawResearchLead(lead)){
        const stealth=await callScrapling(url);
        if(stealth?.html){
          result=stealth;
          resultLinks=[...new Set([...bingResultLinks(stealth.html),...markdownResultLinks(stealth.html)])];
          await redis.hIncrBy(STATS,"scrapling_search_hit",1);
        }
      }
      return {q,url,...(result||{html:"",final_url:url,status:0}),resultLinks};
    }));
    const links=[];
    for(const item of searchResults){
      if(item.status!=="fulfilled")continue;
      const result=item.value;
      const searchText=stripHtml(result.html).slice(0,10000);
      // Search snippets are discovery hints only. Never qualify an email from a
      // Bing SERP itself; the address must be corroborated on a matched source page.
      texts.push(searchText);
      for(const link of (result.resultLinks||bingResultLinks(result.html))
        .filter(u=>lawSourceRank(u,lead)<90)
        .sort((a,b)=>lawSourceRank(a,lead)-lawSourceRank(b,lead))){
        if(!links.includes(link))links.push(link);
        if(links.length>=pageBudget)break;
      }
    }
    // Fetch actual source pages for corroboration. Search-result snippets are
    // never treated as publish-source evidence.
    if(links.length)await redis.hIncrBy(STATS,"bing_source_links",links.length);
    const pages=await Promise.allSettled(links.slice(0,pageBudget).map((target,pageIndex)=>fetchResearchPage(target,lead,key,pageIndex<2)));
    for(let i=0;i<pages.length;i++){
      const item=pages[i];
      if(item.status!=="fulfilled")continue;
      const page=item.value,target=links[i];
      if(!page?.html)continue;
      const pageText=stripHtml(page.html).slice(0,22000);
      if(!pageMatchesLead(pageText,lead))continue;
      const discoveredEmails=contextualEmails(page.html,lead,page.final_url||target);
      const wantedSet=new Set((wantedEmails||[]).map(x=>String(x||"").trim().toLowerCase()));
      const pageEmails=wantedSet.size?discoveredEmails.filter(x=>wantedSet.has(String(x).toLowerCase())):discoveredEmails;
      emails.push(...pageEmails);texts.push(pageText);
      const estimate=attorneyEstimate(page.html,pageText);
      if(estimate>attorneyCount){attorneyCount=estimate;attorneyCountSource=page.final_url||target;}
      if(!personalFact){
        const fact=specificFactFromText(pageText,lead);
        if(fact){personalFact=fact;personalFactSource=page.final_url||target;}
      }
      await redis.hIncrBy(STATS,"bing_source_pages_matched",1);
      if(pageEmails.length){
        sources.unshift(page.final_url||target);
        await redis.hIncrBy(STATS,"bing_source_email_pages",1);
      }
    }
  }catch{}
  return {emails:[...new Set(emails)],text:texts.join(" ").slice(0,24000),source:sources[0]||"",attorneyCount,attorneyCountSource,personalFact,personalFactSource};
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
    {re:/\bformer\s+(?:county\s+|state\s+|federal\s+)?prosecutor\b/i,make:()=>"Former prosecutor"},
    {re:/\b(?:served|worked)\s+as\s+(?:a\s+)?(?:county\s+|state\s+|federal\s+)?prosecutor\b/i,make:()=>"Prosecutor experience"},
    {re:/\bformer\s+public\s+defender\b/i,make:()=>"Former public defender"},
    {re:/\bformer\s+(?:judge|magistrate)\b/i,make:()=>"Former judge"},
    {re:/\bformer\s+(?:judicial\s+)?law\s+clerk\b/i,make:()=>"Former judicial law clerk"},
    {re:/\bboard[- ]certified\b/i,make:()=>"Board-certified attorney"},
    {re:/\bcertified\s+(?:legal\s+)?specialist\b/i,make:()=>"Certified legal specialist"},
    {re:/\bsuper\s+lawyers?\b/i,make:()=>"Super Lawyers recognition"},
    {re:/\bav\s+preeminent\b/i,make:()=>"AV Preeminent rating"},
    {re:/\bbest\s+lawyers?\b/i,make:()=>"Best Lawyers recognition"},
    {re:/\bmillion\s+dollar\s+advocates?\b/i,make:()=>"Million Dollar Advocates member"},
    {re:/\b(?:founded|established)\s+(?:in\s+)?((?:19|20)\d{2})\b/i,make:m=>`Established ${m[1]}`},
    {re:/\bserving\b.{0,80}?\bsince\s+((?:19|20)\d{2})\b/i,make:m=>`Serving clients since ${m[1]}`},
    {re:/\b(\d{1,2})\+?\s+years?\s+(?:of\s+)?(?:combined\s+)?(?:legal\s+)?experience\b/i,make:m=>`${m[1]}+ years legal experience`}
  ];
  for(const p of patterns){
    const m=plain.match(p.re);
    if(m)return p.make(m);
  }
  return "";
}
async function duckFallback(lead,key=""){
  const baseQueries=lawResearchQueries(lead);
  const people=attorneyNameVariants(lead);
  const primaryPerson=people[0]||"";
  const alternatePerson=people[1]||"";
  const region=String(lead.region||lead.state||lead.state_code||"").trim();
  const phone=String(lead.phone||"").replace(/\D+/g,"").slice(-10);
  // High-yield first wave: identity + bar + public court/legal records.
  const attorneyQueries=[
    ...(primaryPerson?[
      `"${primaryPerson}" ${region} attorney email`.trim(),
      `"${primaryPerson}" ${region} state bar email`.trim(),
      `"${primaryPerson}" email site:govinfo.gov`,
      `"${primaryPerson}" email site:docs.justia.com`
    ]:[]),
    ...(alternatePerson?[
      `"${alternatePerson}" ${region} attorney email`.trim(),
      `"${alternatePerson}" ${region} state bar email`.trim()
    ]:[]),
    ...(phone&&primaryPerson?[
      `"${primaryPerson}" "${phone}" email`,
      `"${phone}" attorney email`
    ]:[])
  ];
  const firmName=String(lead.name||lead.title||"").replace(/"/g,"").trim();
  const headcountQueries=firmName?[
    `"${firmName}" "Firm Size"`,
    `"${firmName}" site:lawyers.com "Firm Size"`,
    `"${firmName}" site:martindale.com "Firm Size"`,
    `"${firmName}" "Lawyers ("`,
    `"${firmName}" "Attorneys ("`,
    `"${firmName}" "team of" attorneys`
  ]:[];
  const existingEmails=[...(Array.isArray(lead.emails)?lead.emails:[]),lead.email]
    .filter(x=>isUsableLawEmail(x)&&!isThirdPartyEmailDomain(x));
  const shape=lawFirmNameShape(lead);
  const prioritizeSize=existingEmails.length>0||shape==="multi"||shape==="firm"||HISTORICAL_QUALIFIED_KEYS.has(key);
  const queries=[...new Set(prioritizeSize
    ? [...headcountQueries.slice(0,4),...attorneyQueries.slice(0,4),...baseQueries,...headcountQueries.slice(4)]
    : [...attorneyQueries,...baseQueries,...headcountQueries])];
  if(!queries.length)return {emails:[],text:"",source:"",attorneyCount:0,personalFact:"",personalFactSource:""};
  const existingAttorneyCount=lead.attorney_count_evidence_verified===true?Number(lead.attorney_count_estimate||0):0;
  if(existingEmails.length&&existingAttorneyCount>=2&&existingAttorneyCount<=10){
    return {
      emails:rankLawEmails(existingEmails).slice(0,5),
      text:"",
      source:String(lead.law_email_source||lead.email_source||lead.personalization_source||lead.google_maps_url||""),
      attorneyCount:existingAttorneyCount,
      attorneyCountSource:String(lead.attorney_count_source||""),
      personalFact:String(lead.personalization_fact||""),
      personalFactSource:String(lead.personalization_source||"")
    };
  }

  // Keep a good existing email, but continue research when firm size is
  // unknown/outside target so headcount can be proved before paid outreach.
  const emails=[...existingEmails],texts=[],sources=[];
  let attorneyCount=existingAttorneyCount,attorneyCountSource=String(lead.attorney_count_source||""),personalFact="",personalFactSource="";
  const visited=new Set();

  const absorbPage=(html="",finalUrl="")=>{
    const pageText=stripHtml(html).slice(0,22000);
    if(!pageMatchesLead(pageText,lead))return;
    const pageEmails=contextualEmails(html,lead,finalUrl);
    if(pageEmails.length){
      emails.push(...pageEmails);
      if(finalUrl&&!sources.includes(finalUrl))sources.unshift(finalUrl);
    }
    texts.push(pageText);
    const estimate=attorneyEstimate(html,pageText);
    if(estimate>attorneyCount){attorneyCount=estimate;attorneyCountSource=finalUrl;}
    if(!personalFact){
      const fact=specificFactFromText(pageText,lead);
      if(fact){personalFact=fact;personalFactSource=finalUrl;}
    }
  };

  const profileUrl=String(lead.social_profile_url||"").trim();
  if(/^https?:\/\//i.test(profileUrl)){
    try{
      const direct=await fetchText(profileUrl,4500);
      absorbPage(direct.html,direct.final_url||profileUrl);
      if(emails.length&&attorneyCount>=2&&attorneyCount<=10)return {emails:rankLawEmails(emails),text:texts.join(" ").slice(0,48000),source:sources[0]||"",attorneyCount,attorneyCountSource,personalFact,personalFactSource};
    }catch{}
  }

  // Two fast search waves. Run searches in parallel, then fetch the best unique pages in parallel.
  const waves=[queries.slice(0,4),queries.slice(4,8)];
  for(const wave of waves){
    if(!wave.length||(emails.length&&attorneyCount>=2&&attorneyCount<=10))break;
    const searchResults=await Promise.allSettled(wave.map(async (q,searchIndex)=>{
      const url="https://html.duckduckgo.com/html/?q="+encodeURIComponent(q);
      let result=null;
      try{result=await fetchText(url,4500);}catch{}
      let resultLinks=result?.html?duckResultLinks(result.html):[];
      if(!resultLinks.length&&searchIndex===0&&highValueLawResearchLead(lead)){
        const stealth=await callScrapling(url);
        if(stealth?.html){
          result=stealth;
          resultLinks=[...new Set([...duckResultLinks(stealth.html),...markdownResultLinks(stealth.html)])];
          await redis.hIncrBy(STATS,"scrapling_search_hit",1);
        }
      }
      return {q,url,...(result||{html:"",final_url:url,status:0}),resultLinks};
    }));

    const pageCandidates=[];
    for(const item of searchResults){
      if(item.status!=="fulfilled")continue;
      const result=item.value;
      const searchText=stripHtml(result.html).slice(0,9000);
      texts.push(searchText);
      const links=(result.resultLinks||duckResultLinks(result.html))
        .filter(u=>lawSourceRank(u,lead)<90)
        .sort((a,b)=>lawSourceRank(a,lead)-lawSourceRank(b,lead));
      for(const link of links){
        if(visited.has(link))continue;
        visited.add(link);
        pageCandidates.push(link);
        if(pageCandidates.length>=8)break;
      }
      if(pageCandidates.length>=8)break;
    }
    if(emails.length&&attorneyCount>=2&&attorneyCount<=10)break;

    const pages=await Promise.allSettled(pageCandidates.slice(0,8).map((target,pageIndex)=>fetchResearchPage(target,lead,key,pageIndex<2)));
    for(let i=0;i<pages.length;i++){
      const item=pages[i];
      if(item.status!=="fulfilled"||!item.value?.html)continue;
      absorbPage(item.value.html,item.value.final_url||pageCandidates[i]);
      if(emails.length>=3&&attorneyCount>=2&&attorneyCount<=10)break;
    }
  }

  const combined=texts.join(" ");
  if(!personalFact){
    const fact=specificFactFromText(combined,lead);
    if(fact){personalFact=fact;personalFactSource=sources[0]||"";}
  }

  return {
    emails:rankLawEmails(emails).slice(0,5),
    text:combined.slice(0,48000),
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

function sameOwnedWebsiteDomain(email="",website=""){
  const emailDomain=String(email).split("@")[1]?.toLowerCase()||"";
  const siteHost=hostOf(website);
  if(!emailDomain||!siteHost)return false;
  return emailDomain===siteHost||siteHost.endsWith("."+emailDomain)||emailDomain.endsWith("."+siteHost);
}
async function validateOwnedWebsiteEmails(values=[],lead={},website=""){
  const unique=[...new Set(values.map(x=>String(x||"").trim().toLowerCase()).filter(x=>isUsableLawEmail(x)&&!isThirdPartyEmailDomain(x)))];
  const checks=await Promise.all(unique.map(async email=>{
    const sameDomain=sameOwnedWebsiteDomain(email,website);
    const identity=emailIdentityStrong(email,lead);
    return {email,ok:(sameDomain||identity)&&await hasMailExchange(email)};
  }));
  return rankLawEmails(checks.filter(x=>x.ok).map(x=>x.email)).slice(0,5);
}
async function auditWebsiteRefreshLead(key,lead={}){
  const website=String(lead.website||"").trim();
  if(!/^https?:\/\//i.test(website))return false;
  if(await redis.sIsMember(WEBSITE_REFRESH_READY_SET,key))return false;

  const homepage=await fetchText(website,6000);
  const homeText=stripHtml(homepage.html).slice(0,30000);
  const audit=websiteAudit({
    html:homepage.html,
    text:homeText,
    url:homepage.final_url||website,
    practiceFocus:String(lead.practice_focus||""),
    elapsedMs:Number(homepage.elapsed_ms||0)
  });
  if((audit.pain_points||[]).length<2){
    await redis.sAdd(WEBSITE_REFRESH_REJECTED_SET,key);
    await redis.hIncrBy(STATS,"website_refresh_rejected_weak",1);
    return true;
  }

  let emails=[...emailsFrom(homepage.html),...contextualEmails(homepage.html,lead)];
  let emailSource=homepage.final_url||website;
  const links=linksFrom(homepage.final_url||website,homepage.html)
    .filter(u=>/\b(contact|about|attorney|lawyer|team|people)\b/i.test(u))
    .slice(0,3);
  if(emails.length<1&&links.length){
    const pages=await Promise.allSettled(links.map(url=>fetchText(url,5000)));
    for(let i=0;i<pages.length;i++){
      const item=pages[i];if(item.status!=="fulfilled")continue;
      const found=[...emailsFrom(item.value.html),...contextualEmails(item.value.html,lead)];
      if(found.length&&!emails.length)emailSource=item.value.final_url||links[i];
      emails.push(...found);
    }
  }
  emails=await validateOwnedWebsiteEmails(emails,lead,homepage.final_url||website);
  if(!emails.length){
    await redis.sAdd(WEBSITE_REFRESH_REJECTED_SET,key);
    await redis.hIncrBy(STATS,"website_refresh_rejected_no_email",1);
    return true;
  }

  const evidence=[lead.category,lead.name,lead.description,lead.descriptions].filter(Boolean).join(" ");
  const practiceKeys=[...new Set([
    ...(Array.isArray(lead.practice_keys)?lead.practice_keys:[]),
    ...lawFirmPracticeKeys(evidence),
    ...(String(lead.practice_focus||"").trim()?[String(lead.practice_focus).trim()]:[])
  ])].filter(k=>LAW_PRACTICES.some(p=>p.key===k)).slice(0,3);
  const practices=practiceKeys.map(k=>LAW_PRACTICES.find(p=>p.key===k)?.label).filter(Boolean);
  const attorneyCount=Number(lead.attorney_count_estimate||0);
  const p=personalization({
    lead,practices,attorneyCount,
    source:homepage.final_url||website,
    targetLabel:practices[0]||"law"
  });
  const priority=priorityScore({
    attorneyCount,
    reviewCount:lead.review_count,
    hasEmail:true,
    painCount:(audit.pain_points||[]).length,
    personalizationQuality:p.quality,
    hasPractice:practiceKeys.length>0
  });
  const primaryEmail=emails[0]||"";
  const siteDomain=hostOf(homepage.final_url||website);
  const [existingEmailKey,existingDomainKey]=await Promise.all([
    primaryEmail?redis.hGet(WEBSITE_REFRESH_EMAIL_INDEX,primaryEmail):Promise.resolve(null),
    siteDomain?redis.hGet(WEBSITE_REFRESH_DOMAIN_INDEX,siteDomain):Promise.resolve(null)
  ]);
  if((existingEmailKey&&existingEmailKey!==key)||(existingDomainKey&&existingDomainKey!==key)){
    await redis.sAdd(WEBSITE_REFRESH_REJECTED_SET,key);
    await redis.hIncrBy(STATS,"website_refresh_duplicate",1);
    return true;
  }

  const refreshed={
    ...lead,
    emails,
    website:homepage.final_url||website,
    website_opportunity:"website_refresh",
    website_audit:audit,
    primary_pain_point:audit.primary_pain_point,
    practice_keys:practiceKeys,
    practice_areas:practices,
    lead_type:practices.join(" + "),
    personalization_fact:p.fact,
    personalization_source:p.source,
    personalization_quality:p.quality,
    law_email_method:"owned_website",
    law_email_source:emailSource,
    law_email_validation:"owned-site+mx",
    lead_priority_score:priority,
    website_refresh_qualified_at:new Date().toISOString()
  };
  await redis.hSet(WEBSITE_REFRESH_HASH,key,JSON.stringify(refreshed));
  await redis.sAdd(WEBSITE_REFRESH_READY_SET,key);
  if(primaryEmail)await redis.hSet(WEBSITE_REFRESH_EMAIL_INDEX,primaryEmail,key);
  if(siteDomain)await redis.hSet(WEBSITE_REFRESH_DOMAIN_INDEX,siteDomain,key);
  await redis.sRem(WEBSITE_REFRESH_REJECTED_SET,key);
  await redis.hIncrBy(STATS,"website_refresh_qualified",1);
  console.log(JSON.stringify({
    event:"law_website_refresh_qualified",key,name:lead.name,
    email:emails[0],painPoints:(audit.pain_points||[]).length,
    primaryPain:audit.primary_pain_point,priority
  }));
  return true;
}
async function websiteAuditBatch(){
  const keys=await popSetBatch(WEBSITE_AUDIT_PENDING_SET,WEBSITE_AUDIT_BATCH);
  if(!keys.length)return 0;
  let index=0,done=0;
  const run=async()=>{
    while(index<keys.length){
      const key=keys[index++];
      try{
        const raw=await redis.hGet(WEBSITE_CANDIDATE_HASH,key);
        if(!raw)continue;
        let lead;try{lead=JSON.parse(raw)||{};}catch{continue;}
        if(await auditWebsiteRefreshLead(key,lead))done++;
      }catch(error){
        const message=String(error?.message||error);
        if(/\bhttp\s+(?:401|403|404|410)\b/i.test(message)){
          await redis.sAdd(WEBSITE_REFRESH_REJECTED_SET,key);
          await redis.hIncrBy(STATS,"website_refresh_blocked_http",1);
          console.warn(JSON.stringify({event:"law_website_audit_blocked",key,error:message}));
        }else{
          await redis.sAdd(WEBSITE_AUDIT_PENDING_SET,key);
          console.warn(JSON.stringify({event:"law_website_audit_retry",key,error:message}));
        }
      }
    }
  };
  await Promise.all(Array.from({length:Math.min(WEBSITE_AUDIT_CONCURRENCY,keys.length)},()=>run()));
  return done;
}

function firmSizeTier(attorneyCount=0){
  const n=Number(attorneyCount||0);
  if(!n) return "unknown";
  if(n===1) return "solo";
  if(n>=2&&n<=10) return "preferred_2_10";
  if(n<=20) return "mid_11_20";
  return "large_21_plus";
}

function priorityScore({attorneyCount=0,reviewCount=0,hasEmail=false,painCount=0,personalizationQuality="none",hasPractice=false}={}){
  let score=0;
  if(attorneyCount>=2&&attorneyCount<=10) score+=35;
  else if(attorneyCount===1) score+=18;
  else if(attorneyCount>10&&attorneyCount<=20) score+=12;
  else if(!attorneyCount) score+=8;
  if(hasEmail) score+=35;
  if(hasPractice) score+=12;
  if(painCount) score+=15;
  if(personalizationQuality==="specific") score+=10;
  else if(personalizationQuality==="basic") score+=3;
  if(Number(reviewCount)>=10) score+=3;
  return Math.min(100,score);
}
function personalization({lead,practices,attorneyCount,source,targetLabel=""}){
  const city=String(lead.city||"").trim();
  const name=String(lead.name||"your firm").trim();
  const safeSource=String(source||lead.google_maps_url||"Google Maps").trim();
  const reviews=Number(lead.review_count||lead.reviews||0);
  const rating=Number(lead.review_rating||lead.rating||0);

  if(attorneyCount>=2&&attorneyCount<=10){
    return {fact:`Team: ~${attorneyCount} attorneys`,source:safeSource,quality:"specific"};
  }
  if(attorneyCount===1){
    return {fact:"Solo practice",source:safeSource,quality:"specific"};
  }
  if(reviews>=5&&rating>0){
    return {fact:`Google: ${reviews} reviews · ${rating.toFixed(1)}★`,source:String(lead.google_maps_url||safeSource),quality:"specific"};
  }
  if(practices.length&&city){
    return {fact:`${practices[0]} · ${city}`,source:safeSource,quality:"basic"};
  }
  if(targetLabel&&city){
    return {fact:`${targetLabel} · ${city}`,source:String(lead.google_maps_url||safeSource),quality:"basic"};
  }
  if(targetLabel){
    return {fact:`${targetLabel} practice`,source:String(lead.google_maps_url||safeSource),quality:"basic"};
  }
  if(city){
    return {fact:`Law firm · ${city}`,source:String(lead.google_maps_url||safeSource),quality:"basic"};
  }
  return {fact:"",source:"",quality:"none"};
}
const STATE_BAR_DOMAINS={
  TX:"texasbar.com",FL:"floridabar.org/directories/find-mbr",CA:"apps.calbar.ca.gov/attorney",NY:"nycourts.gov",
  NJ:"njcourts.gov",PA:"pabar.org",IL:"iardc.org",OH:"supremecourt.ohio.gov",
  GA:"gabar.org",NC:"ncbar.gov",SC:"scbar.org",VA:"vsb.org",WA:"wsba.org",
  OR:"osbar.org",AZ:"azbar.org",CO:"coloradosupremecourt.com",MI:"michbar.org",
  MN:"mnbars.org",MO:"mobar.org",TN:"tbpr.org",MA:"massbbo.org",MD:"mdcourts.gov"
};
function stateBarDomain(lead={}){
  const state=String(lead.region||lead.state||lead.state_code||"").trim().toUpperCase();
  return STATE_BAR_DOMAINS[state]||"";
}
function expectedBarHost(lead={}){
  const raw=stateBarDomain(lead);
  if(!raw)return "";
  try{return new URL("https://"+raw).hostname.toLowerCase().replace(/^www\./,"");}
  catch{return String(raw).split("/")[0].toLowerCase().replace(/^www\./,"");}
}
function trustedLawSource(url="",lead={}){
  let host="";try{host=new URL(String(url||"")).hostname.toLowerCase().replace(/^www\./,"");}catch{return false;}
  const expected=expectedBarHost(lead);
  if(expected&&(host===expected||host.endsWith("."+expected)))return true;
  return /texasbar\.com|floridabar\.org|calbar\.ca\.gov|nycourts\.gov|iardc\.org|supremecourt|disciplinaryboard|statebar|barassociation/i.test(host)||
    host.endsWith(".gov");
}
function lawSourceRank(url="",lead={}){
  let host="";try{host=new URL(String(url||"")).hostname.toLowerCase().replace(/^www\./,"");}catch{return 99;}
  const expected=expectedBarHost(lead);
  if(expected&&(host===expected||host.endsWith("."+expected)))return 0;
  if(trustedLawSource(url,lead))return 1;
  if(/govinfo\.gov|docs\.justia\.com/i.test(host))return 2;
  if(/justia\.com|lawyers\.com|martindale\.com|findlaw\.com|avvo\.com|superlawyers\.com/i.test(host))return 3;
  if(/allbiz\.com|chamberofcommerce\.com|manta\.com|bbb\.org/i.test(host))return 4;
  if(/facebook\.com|linkedin\.com|instagram\.com|tiktok\.com|youtube\.com|x\.com|twitter\.com|pinterest\.com|mapquest\.com/i.test(host))return 90;
  return 6;
}
function emailRecoveryPriority(lead={}){
  let score=0;
  if(likelyAttorneyName(lead))score+=2;
  if(String(lead.phone||"").replace(/\D+/g,"").slice(-10).length===10)score+=2;
  if(stateBarDomain(lead))score+=1;
  if(String(lead.city||"").trim())score+=1;
  return score;
}
function stateBarQueries(lead={},people=[]){
  const state=String(lead.region||lead.state||lead.state_code||"").trim().toUpperCase();
  const name=String(lead.name||lead.title||"").replace(/"/g,"").trim();
  const person=people[0]||"";
  const alternate=people[1]||"";
  const out=[];
  if(state==="FL"){
    if(person)out.push(`site:floridabar.org/directories/find-mbr/profile "${person}"`);
    if(alternate)out.push(`site:floridabar.org/directories/find-mbr/profile "${alternate}"`);
    if(name)out.push(`site:floridabar.org/directories/find-mbr "${name}"`);
  }else if(state==="CA"){
    if(person)out.push(`site:apps.calbar.ca.gov/attorney "${person}"`);
    if(alternate)out.push(`site:apps.calbar.ca.gov/attorney "${alternate}"`);
    if(name)out.push(`site:apps.calbar.ca.gov/attorney "${name}"`);
  }else if(state==="TX"){
    if(person)out.push(`site:texasbar.com "Find A Lawyer" "${person}"`);
    if(name)out.push(`site:texasbar.com "Find A Lawyer" "${name}"`);
    if(person)out.push(`"${person}" Texas attorney email filetype:pdf`);
  }else if(state==="NY"){
    if(person)out.push(`site:nycourts.gov "${person}" attorney`);
    if(name)out.push(`site:nycourts.gov "${name}" attorney`);
  }else{
    const domain=stateBarDomain(lead);
    if(domain&&person)out.push(`site:${domain} "${person}" attorney`);
    if(domain&&name)out.push(`site:${domain} "${name}"`);
  }
  return [...new Set(out)].slice(0,4);
}


function isDirectPublishedEmailSource(source=""){
  try{
    const u=new URL(String(source||""));
    const host=u.hostname.toLowerCase().replace(/^www\./,"");
    if(!/^https?:$/.test(u.protocol))return false;
    if(/(^|\.)(bing\.com|google\.com|duckduckgo\.com)$/.test(host))return false;
    return true;
  }catch{return false;}
}

async function enrichLead(key,lead){
  if(String(lead.search_profile||"")!=="law-firm"&&normalize(lead.industry)!=="law firm")return false;
  if(!isLawFirmLead(lead)){
    await redis.sAdd(ENRICHED_SET,key);
    await redis.sAdd(REJECTED_SET,key);
    await redis.sRem(READY_SET,key);
    await redis.hIncrBy(STATS,"rejected_not_law_firm",1);
    return true;
  }
  if(await redis.sIsMember(ENRICHED_SET,key))return false;

  const website=String(lead.website||"").trim();
  if(/^https?:\/\//i.test(website)){
    await redis.sAdd(ENRICHED_SET,key);
    await redis.sAdd(REJECTED_SET,key);
    await redis.hIncrBy(STATS,"rejected_has_website",1);
    return true;
  }

  const existingSource=String(lead.law_email_source||lead.email_source||lead.email_evidence_url||"").trim();
  const existingCandidates=[...(Array.isArray(lead.emails)?lead.emails:[]),lead.email]
    .map(x=>String(x||"").trim().toLowerCase())
    .filter(x=>isUsableLawEmail(x)&&!isThirdPartyEmailDomain(x));
  const existingSourceBacked=isDirectPublishedEmailSource(existingSource);
  let emails=existingSourceBacked?existingCandidates:[], combined="",source=existingSourceBacked?existingSource:"",attorneyCount=lead.attorney_count_evidence_verified===true?Number(lead.attorney_count_estimate||0):0;
  let attorneyCountVerified=lead.attorney_count_evidence_verified===true&&attorneyCount>0,attorneyCountSource=attorneyCountVerified?String(lead.attorney_count_source||""):"";
  let personalFact="",personalFactSource="";
  let emailMethod=emails.length?"existing_source_backed":"none";
  if(emailMethod!=="none")await redis.hIncrBy(STATS,"email_existing_hit",1);

  // Recover previously-known emails safely before rediscovering from scratch.
  // The exact address must appear on a matched public page; SERP text never counts.
  if(emailMethod==="none"&&!existingSourceBacked&&existingCandidates.length){
    const leadName=String(lead.name||lead.title||"").replace(/"/g,"").trim();
    const exactQueries=existingCandidates.slice(0,3).flatMap(email=>[
      `"${email}" "${leadName}"`,
      `"${email}" attorney`
    ]);
    const exactResult=await bingFallback(lead,exactQueries,10,key,existingCandidates).catch(()=>null);
    if(exactResult?.emails?.length){
      emails.push(...exactResult.emails);
      combined+=" "+String(exactResult.text||"");
      source=String(exactResult.source||source||"");
      const exactCount=Number(exactResult.attorneyCount||0);
      const exactCountSource=String(exactResult.attorneyCountSource||"");
      if(exactCount>0&&isDirectPublishedEmailSource(exactCountSource)){
        attorneyCount=exactCount;
        attorneyCountVerified=true;
        attorneyCountSource=exactCountSource;
      }
      emailMethod="existing_email_recorroborated";
      await redis.hIncrBy(STATS,"email_existing_recorroborated",1);
    }else{
      await redis.hIncrBy(STATS,"email_existing_recorroboration_miss",1);
    }
  }

  // Run general discovery only when exact stored-email corroboration did not work.
  if(emailMethod==="none"){
    const name=String(lead.name||lead.title||"").replace(/"/g,"").trim();
    const phone=String(lead.phone||"").replace(/\D+/g,"").slice(-10);
    const city=String(lead.city||"").trim(),region=String(lead.region||lead.state||"").trim();
    const people=attorneyNameVariants(lead);
    const person=people[0]||"";
    const alternate=people[1]||"";
    const barDomain=stateBarDomain(lead);
    const barQueries=stateBarQueries(lead,people);
    const bingQueries=[...new Set([
      ...(phone&&name?[`"${name}" "${phone}"`]:[]),
      ...(barQueries[0]?[barQueries[0]]:[]),
      ...(person?[`"${person}" ${region} attorney email`.trim()]:[]),
      ...(name?[`"${name}" ${city} ${region} email`.trim()]:[]),
      ...(phone?[`"${phone}" attorney email`]:[]),
      ...(name?[`"${name}" site:allbiz.com OR site:chamberofcommerce.com email`]:[]),
      ...(barQueries[1]?[barQueries[1]]:[]),
      ...(alternate?[`"${alternate}" ${region} attorney email`.trim()]:[])
    ].filter(Boolean))];
    const useDeepIdentity=emailRecoveryPriority(lead)>=4;
    const [bingResult,zeroResult]=await Promise.allSettled([
      bingFallback(lead,bingQueries,emailRecoveryPriority(lead)>=5?10:8,key),
      useDeepIdentity?zeroCostEmailFallback(lead):Promise.resolve({emails:[],source:"",name_variant:""})
    ]);

    if(bingResult.status==="fulfilled"){
      const bf=bingResult.value;
      emails.push(...bf.emails);
      combined+=" "+bf.text;
      if(bf.source)source=bf.source;
      const bfCount=Number(bf.attorneyCount||0);
      const bfCountSource=String(bf.attorneyCountSource||"");
      if(bfCount>0&&isDirectPublishedEmailSource(bfCountSource)){
        attorneyCountVerified=true;
        if(bfCount>=attorneyCount){attorneyCount=bfCount;attorneyCountSource=bfCountSource;}
      }
      if(bf.personalFact){personalFact=bf.personalFact;personalFactSource=bf.personalFactSource||bf.source||"";}
      if(bf.emails.length){
        emailMethod="bing";
        await redis.hIncrBy(STATS,"email_bing_hit",1);
      }
    }
    if(zeroResult.status==="fulfilled"&&zeroResult.value.emails.length){
      const zeroCost=zeroResult.value;
      emails.push(...zeroCost.emails);
      if(!source)source=zeroCost.source||"";
      if(emailMethod==="none")emailMethod="zero_cost";
      await redis.hIncrBy(STATS,"email_zero_cost_hit",1);
    }
  }

  emails=rankLawEmails(emails.map(x=>String(x).toLowerCase().trim())
    .filter(x=>isUsableLawEmail(x)&&!isThirdPartyEmailDomain(x))).slice(0,5);

  let fb={emails:[],text:"",source:"",attorneyCount:0,attorneyCountSource:"",personalFact:"",personalFactSource:""};
  const needsHeadcount=emails.length>0&&!(attorneyCount>=2&&attorneyCount<=10);
  if((!emails.length&&emailRecoveryPriority(lead)>=5)||needsHeadcount){
    fb=await duckFallback({...lead,emails,attorney_count_estimate:attorneyCount,law_email_source:source,website:""},key);
    emails.push(...fb.emails);
    combined+=" "+fb.text;
    if(fb.source)source=fb.source;
    const fbCount=Number(fb.attorneyCount||0);
    const fbCountSource=String(fb.attorneyCountSource||"");
    if(fbCount>0&&isDirectPublishedEmailSource(fbCountSource)){
      attorneyCountVerified=true;
      if(fbCount>=attorneyCount){attorneyCount=fbCount;attorneyCountSource=fbCountSource;}
    }
    if(fb.personalFact){personalFact=fb.personalFact;personalFactSource=fb.personalFactSource||fb.source||"";}
    if(fb.emails.length){
      emailMethod="duck";
      await redis.hIncrBy(STATS,"email_duck_hit",1);
    }
  }

  emails=rankLawEmails(emails.map(x=>String(x).toLowerCase().trim())
    .filter(x=>isUsableLawEmail(x)&&!isThirdPartyEmailDomain(x))).slice(0,5);
  const rawCandidateCount=emails.length;
  if(rawCandidateCount)await redis.hIncrBy(STATS,"email_raw_candidate_leads",1);
  emails=await filterContactableEmails(emails,lead);
  const identityMxCount=emails.length;
  if(identityMxCount)await redis.hIncrBy(STATS,"email_identity_mx_pass_leads",1);
  else if(rawCandidateCount)await redis.hIncrBy(STATS,"email_identity_mx_reject_leads",1);
  emails=await keeleadVerifiedEmails(emails);
  if(emails.length)await redis.hIncrBy(STATS,"email_keelead_pass_leads",1);
  else if(identityMxCount)await redis.hIncrBy(STATS,"email_keelead_reject_leads",1);
  const emailSourceVerified=emails.length>0&&isDirectPublishedEmailSource(source);
  if(emailSourceVerified)await redis.hIncrBy(STATS,"email_source_verified_leads",1);

  // Conversion pass: once a real published email survives identity/MX/verifier,
  // spend extra research only on proving firm size. This is intentionally
  // conditional so we do not multiply search cost across the full backlog.
  if(emailSourceVerified&&!attorneyCountVerified){
    const sizeName=String(lead.name||lead.title||"").replace(/"/g,"").trim();
    const sizeRegion=String(lead.region||lead.state||"").trim();
    const sizeQueries=sizeName?[
      `"${sizeName}" "firm size"`,
      `"${sizeName}" attorneys lawyers ${sizeRegion}`.trim(),
      `"${sizeName}" site:lawyers.com "Firm Size"`,
      `"${sizeName}" site:martindale.com "Firm Size"`,
      `"${sizeName}" site:justia.com attorneys`
    ]:[];
    if(sizeQueries.length){
      const sizeResearch=await bingFallback(lead,sizeQueries,10,key).catch(()=>null);
      const verifiedCount=Number(sizeResearch?.attorneyCount||0);
      const verifiedSource=String(sizeResearch?.attorneyCountSource||"");
      if(verifiedCount>0&&isDirectPublishedEmailSource(verifiedSource)){
        attorneyCount=verifiedCount;
        attorneyCountVerified=true;
        attorneyCountSource=verifiedSource;
        await redis.hIncrBy(STATS,"post_email_headcount_verified",1);
      }else{
        await redis.hIncrBy(STATS,"post_email_headcount_miss",1);
      }
    }
  }

  if(!emails.length||!emailSourceVerified){
    emails=[];
    emailMethod="none";
    await redis.hIncrBy(STATS,"email_no_hit",1);
    await redis.hIncrBy(STATS,"email_unqualified_or_unreachable",1);
  }
  const personalizationSource=source||String(lead.google_maps_url||"Google Maps");
  const metadataText=[lead.category,lead.name,lead.description,lead.descriptions].filter(Boolean).join(" ");
  const metadataKeys=lawFirmPracticeKeys(metadataText);
  const researchKeys=lawFirmPracticeKeys(combined);
  const focus=String(lead.practice_focus||metadataKeys[0]||researchKeys[0]||"").trim();
  const targetPractice=LAW_PRACTICES.find(x=>x.key===focus);
  // Keep Type credible and compact. Discovery focus/direct business evidence outrank
  // broad search-result text, which can mention unrelated legal specialties.
  const practiceKeys=[...new Set([
    ...(focus?[focus]:[]),
    ...metadataKeys,
    ...researchKeys
  ])].filter(k=>LAW_PRACTICES.some(p=>p.key===k)).slice(0,3);
  const practices=practiceKeys.map(k=>LAW_PRACTICES.find(p=>p.key===k)?.label).filter(Boolean);
  const observedPractices=practices;
  const targetLabel=targetPractice?.label||practices[0]||"law";
  let p=personalization({lead,practices:observedPractices,attorneyCount,source:personalizationSource,targetLabel});
  if(personalFact){
    p={fact:personalFact,source:personalFactSource||source||String(lead.google_maps_url||"Google Maps"),quality:"specific"};
  }
  const sizeTier=firmSizeTier(attorneyCount);
  const preferredSize=attorneyCountVerified&&attorneyCount>=2&&attorneyCount<=10;
  const painPoint="No website";
  const evidenceOwnedWebsite=!website&&emailSourceVerified&&emails.length
    ? await detectOwnedWebsiteFromEvidenceSource(source,emails,lead,key)
    : "";
  const discoveredOwnedWebsite=!website&&emails.length
    ? (evidenceOwnedWebsite||await detectOwnedWebsiteFromEmailDomains(emails,lead))
    : "";
  const effectiveWebsite=website||discoveredOwnedWebsite;
  const emailCandidate=!effectiveWebsite&&emailSourceVerified&&emails.length>0;
  if(emailCandidate)await redis.sAdd(EMAIL_CANDIDATE_SET,key);
  else await redis.sRem(EMAIL_CANDIDATE_SET,key);
  const qualified=qualifiesNoWebsiteLawLead({
    website:effectiveWebsite,
    emails,
    practice_keys:practiceKeys,
    attorney_count_estimate:attorneyCount,
    attorney_count_evidence_verified:attorneyCountVerified,
    email_source_verified:emailSourceVerified
  });
  const priority=priorityScore({
    attorneyCount,
    reviewCount:lead.review_count,
    hasEmail:emails.length>0,
    painCount:1,
    personalizationQuality:p.quality,
    hasPractice:practiceKeys.length>0
  });
  const city=String(lead.city||"").trim();
  const emailAngle=qualified
    ? `Saw ${lead.name||"your firm"} while looking at ${targetLabel} firms${city?` in ${city}`:""}.${p.fact?` ${p.fact}.`:""} Couldn't find a firm website, so I reached out.`
    : "";

  const enriched={...lead,website:effectiveWebsite,emails,attorney_count_estimate:attorneyCount||null,attorney_count_evidence_verified:attorneyCountVerified,attorney_count_source:attorneyCountSource||"",preferred_firm_size:preferredSize,
    firm_size_tier:sizeTier,practice_areas:practices,practice_keys:practiceKeys,
    lead_type:practices.join(" + "),personalization_fact:p.fact,personalization_source:p.source,
    personalization_quality:p.quality,website_opportunity:"website_build",website_audit:null,primary_pain_point:painPoint,
    target_area:String(lead.acquisition_location||[lead.city,lead.region].filter(Boolean).join(", ")||"").trim(),
    email_angle:emailAngle,lead_priority_score:priority,qualified_lead:qualified,
    law_email_enrich_version:EMAIL_METHOD_VERSION,
    law_email_method:emailMethod,law_email_source:source||"",
    law_email_source_verified:emailSourceVerified,
    law_email_validation:emailSourceVerified?"published+identity+mx":"rejected",
    law_bar_domain:stateBarDomain(lead),
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
    if(!emails.length||!emailSourceVerified) await redis.hIncrBy(STATS,"rejected_no_verified_email",1);
    else if(!preferredSize) await redis.hIncrBy(STATS,"rejected_wrong_size",1);
    else if(effectiveWebsite) await redis.hIncrBy(STATS,"rejected_has_website",1);
  }
  const rejectReason=qualified?"":effectiveWebsite?"owned_website":!emails.length||!emailSourceVerified?"no_verified_email":!attorneyCountVerified?"unverified_attorney_count":!preferredSize?"wrong_size":"other";
  console.log(JSON.stringify({event:"law_firm_enriched",key,name:lead.name,emails:emails.length,emailMethod,attorneyCount:attorneyCount||null,attorneyCountVerified,attorneyCountSource:attorneyCountSource||"",effectiveWebsite:effectiveWebsite||"",sizeTier,practice:practices[0]||"",painPoint,qualified,rejectReason,priority,personalizationQuality:p.quality}));
  return true;
}
async function cleanupWebsiteRefreshReady(){
  const keys=await redis.sMembers(WEBSITE_REFRESH_READY_SET);
  if(!keys.length)return {kept:0,removed:0};
  const values=await redis.hmGet(WEBSITE_REFRESH_HASH,keys);
  const rows=[];
  for(let i=0;i<keys.length;i++){
    if(!values[i])continue;
    let lead;try{lead=JSON.parse(values[i])||{};}catch{continue;}
    const email=String((Array.isArray(lead.emails)?lead.emails[0]:lead.email)||"").toLowerCase();
    const pains=Array.isArray(lead.website_audit?.pain_points)?lead.website_audit.pain_points:[];
    if(!isLawFirmLead(lead)||!isUsableLawEmail(email)||pains.length<2){
      rows.push({key:keys[i],lead,priority:-999,invalid:true});
      continue;
    }
    rows.push({key:keys[i],lead,priority:Number(lead.lead_priority_score||0),invalid:false});
  }
  rows.sort((a,b)=>b.priority-a.priority);
  const emails=new Set(),domains=new Set(),remove=[];
  await redis.del(WEBSITE_REFRESH_EMAIL_INDEX);
  await redis.del(WEBSITE_REFRESH_DOMAIN_INDEX);
  for(const row of rows){
    const email=String((Array.isArray(row.lead.emails)?row.lead.emails[0]:row.lead.email)||"").toLowerCase();
    const domain=hostOf(row.lead.website||"");
    if(row.invalid||(email&&emails.has(email))||(domain&&domains.has(domain))){
      remove.push(row.key);continue;
    }
    if(email){emails.add(email);await redis.hSet(WEBSITE_REFRESH_EMAIL_INDEX,email,row.key);}
    if(domain){domains.add(domain);await redis.hSet(WEBSITE_REFRESH_DOMAIN_INDEX,domain,row.key);}
  }
  if(remove.length){
    await redis.sRem(WEBSITE_REFRESH_READY_SET,remove);
    await redis.sAdd(WEBSITE_REFRESH_REJECTED_SET,remove);
  }
  console.log(JSON.stringify({event:"law_website_refresh_cleanup",kept:rows.length-remove.length,removed:remove.length}));
  return {kept:rows.length-remove.length,removed:remove.length};
}

async function bootstrapExistingQualified(){
  let scanned=0,qualifiedAdded=0,qualifiedRemoved=0,queuedForEnrichment=0,alreadyQualified=0,requalifyQueued=0,historicalQualifiedMarkers=0;
  const fullRequalify=(await redis.get(REQUALIFY_VERSION_KEY))!==EMAIL_METHOD_VERSION;
  const historicalRecovery=(await redis.get(HISTORICAL_RECOVERY_VERSION_KEY))!==EMAIL_METHOD_VERSION;
  const readySet=new Set(await redis.sMembers(READY_SET));
  const requalSizeReady=[],requalRegular=[],requalPriority=[],requalRecoverable=[],requalAll=[];

  if(historicalRecovery){
    const historicalKeys=[...HISTORICAL_QUALIFIED_KEYS];
    const historicalValues=await redis.hmGet(LEAD_HASH,historicalKeys);
    const present=historicalKeys.filter((_,i)=>Boolean(historicalValues[i]));
    if(present.length){
      for(let i=0;i<present.length;i+=250){
        const chunk=present.slice(i,i+250);
        await Promise.all([
          redis.sRem(ENRICHED_SET,chunk),
          redis.sRem(RECOVERABLE_PENDING_SET,chunk),
          redis.sRem(PRIORITY_PENDING_SET,chunk),
          redis.sRem(SOURCE_PENDING_SET,chunk)
        ]);
        await redis.sAdd(PENDING_SET,chunk);
      }
    }
    await redis.set(HISTORICAL_RECOVERY_VERSION_KEY,EMAIL_METHOD_VERSION);
    console.log(JSON.stringify({event:"law_historical_recovery_queued",requested:historicalKeys.length,present:present.length}));
  }

  if(fullRequalify){
    // Rebuild historical work queues from scratch in bulk. Fresh worker output
    // uses SOURCE_PENDING_SET and is intentionally preserved.
    await Promise.all([
      redis.del(PENDING_SET),
      redis.del(SIZE_READY_PENDING_SET),
      redis.del(PRIORITY_PENDING_SET),
      redis.del(RECOVERABLE_PENDING_SET)
    ]);
  }

  for await(const page of redis.hScanIterator(LEAD_HASH,{COUNT:1000})){
    for(const entry of (Array.isArray(page)?page:[page])){
      if(!entry?.field||entry.value===undefined)continue;
      let lead;try{lead=JSON.parse(entry.value)||{};}catch{continue;}
      const isLaw=(String(lead.search_profile||"")==="law-firm"||normalize(lead.industry)==="law firm")&&isLawFirmLead(lead);
      const wasQualified=readySet.has(entry.field);
      if(!isLaw){
        if(wasQualified){
          await redis.sRem(READY_SET,entry.field);
          readySet.delete(entry.field);
          qualifiedRemoved++;
        }
        continue;
      }
      scanned++;

      const website=String(lead.website||"").trim();
      const existingSource=String(lead.law_email_source||lead.email_source||lead.email_evidence_url||"").trim();
      const sourceBacked=isDirectPublishedEmailSource(existingSource);
      const identityEmails=sourceBacked?[...(Array.isArray(lead.emails)?lead.emails:[]),lead.email]
        .map(x=>String(x||"").trim().toLowerCase())
        .filter(x=>emailIdentityStrong(x,lead)):[];
      const emailChecks=identityEmails.length
        ? await Promise.all(identityEmails.map(async email=>({email,ok:await hasMailExchange(email)})))
        : [];
      const mxEmails=emailChecks.filter(x=>x.ok).map(x=>x.email);
      const emails=await keeleadVerifiedEmails(mxEmails);
      const attorneyCount=lead.attorney_count_evidence_verified===true?Number(lead.attorney_count_estimate||0):0;
      const evidenceText=[lead.category,lead.name,lead.description,lead.descriptions].filter(Boolean).join(" ");
      const observedKeys=lawFirmPracticeKeys(evidenceText);
      const storedKeys=Array.isArray(lead.practice_keys)?lead.practice_keys:[];
      const focus=String(lead.practice_focus||"").trim();
      const practiceKeys=[...new Set([...storedKeys,...observedKeys,...(focus?[focus]:[])])];

      let effectiveWebsite=website;
      const bootstrapSizeReady=lead.attorney_count_evidence_verified===true&&Number(lead.attorney_count_estimate||0)>=2&&Number(lead.attorney_count_estimate||0)<=10;
      if(!fullRequalify&&!website&&bootstrapSizeReady&&(!sourceBacked||!emails.length)){
        await redis.sRem(ENRICHED_SET,entry.field);
        await moveToEmailQueue(entry.field,SIZE_READY_PENDING_SET);
        queuedForEnrichment++;
      }
      if(wasQualified&&!website&&emails.length){
        const fromSource=await detectOwnedWebsiteFromEvidenceSource(existingSource,emails,lead,entry.field);
        const discovered=fromSource||await detectOwnedWebsiteFromEmailDomains(emails,lead);
        if(discovered){
          effectiveWebsite=discovered;
          const updatedLead={...lead,website:discovered,website_opportunity:"website_refresh",owned_website_evidence_source:fromSource?existingSource:"email_domain_http"};
          await redis.hSet(LEAD_HASH,entry.field,JSON.stringify(updatedLead));
        }
      }

      if(fullRequalify&&!effectiveWebsite){
        const name=String(lead.name||lead.title||"");
        const existingUsable=emails.length>0||mxEmails.length>0;
        const multiName=/\b(law offices|attorneys at law|law group|partners|associates|attorneys|&| and )\b/i.test(name);
        const historicalQualified=HISTORICAL_QUALIFIED_KEYS.has(entry.field)||lead.qualified_lead===true||Boolean(lead.law_firm_qualified_at)||lead.law_email_source_verified===true||/identity\+mx|source\+identity\+mx|published\+identity\+mx/i.test(String(lead.law_email_validation||""));
        if(historicalQualified)historicalQualifiedMarkers++;
        requalAll.push(entry.field);
        const nameShape=lawFirmNameShape(lead);
        const sizeReady=lead.attorney_count_evidence_verified===true&&Number(lead.attorney_count_estimate||0)>=2&&Number(lead.attorney_count_estimate||0)<=10;
        if(sizeReady)requalSizeReady.push(entry.field);
        else if(historicalQualified||existingUsable)requalRegular.push(entry.field);
        else if(nameShape==="multi"||nameShape==="firm"||multiName||emailRecoveryPriority(lead)>=5)requalPriority.push(entry.field);
        else requalRecoverable.push(entry.field);
        requalifyQueued++;
      }

      const qualifies=qualifiesNoWebsiteLawLead({
        website:effectiveWebsite,
        emails,
        practice_keys:practiceKeys,
        attorney_count_estimate:attorneyCount,
        attorney_count_evidence_verified:lead.attorney_count_evidence_verified===true,
        email_source_verified:sourceBacked&&emails.length>0
      });

      if(!qualifies){
        if(wasQualified){
          await redis.sRem(READY_SET,entry.field);
          readySet.delete(entry.field);
          qualifiedRemoved++;
        }
        if(!fullRequalify){
          if(!effectiveWebsite&&(!emails.length||!sourceBacked)&&String(lead.law_email_enrich_version||"")!==EMAIL_METHOD_VERSION){
            if(bootstrapSizeReady){
              await redis.sRem(ENRICHED_SET,entry.field);
              await moveToEmailQueue(entry.field,SIZE_READY_PENDING_SET);
              queuedForEnrichment++;
            }else if(emailRecoveryPriority(lead)>=5){
              await redis.sRem(ENRICHED_SET,entry.field);
              await moveToEmailQueue(entry.field,RECOVERABLE_PENDING_SET);
              queuedForEnrichment++;
            }
          }else if(!effectiveWebsite&&emails.length&&(!practiceKeys.length||!attorneyCount)){
            await redis.sRem(ENRICHED_SET,entry.field);
            await moveToEmailQueue(entry.field,PENDING_SET);
            queuedForEnrichment++;
          }
        }
        continue;
      }

      if(wasQualified){
        alreadyQualified++;
        continue;
      }

      const practices=[...new Set(practiceKeys.map(k=>LAW_PRACTICES.find(p=>p.key===k)?.label).filter(Boolean))];
      const targetLabel=practices[0]||"law";
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
        personalizationQuality:p.quality,
        hasPractice:practiceKeys.length>0
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
        preferred_firm_size:true,
        firm_size_tier:firmSizeTier(attorneyCount),
        personalization_fact:personalFact,
        personalization_source:String(lead.personalization_source||p.source||""),
        personalization_quality:String(lead.personalization_quality||p.quality||"basic"),
        website_opportunity:"website_build",
        primary_pain_point:"No website",
        email_angle:opener,
        lead_priority_score:priority,
        qualified_lead:true,
        law_email_source_verified:true,
        law_email_validation:"source+identity+mx",
        law_email_enrich_version:String(lead.law_email_enrich_version||EMAIL_METHOD_VERSION),
        law_firm_qualified_at:new Date().toISOString()
      };
      await redis.hSet(LEAD_HASH,entry.field,JSON.stringify(updated));
      await redis.sAdd(READY_SET,entry.field);
      readySet.add(entry.field);
      await redis.hIncrBy(STATS,"qualified",1);
      qualifiedAdded++;
    }
  }

  if(fullRequalify){
    const addChunks=async(setKey,keys)=>{
      for(let i=0;i<keys.length;i+=500){
        const chunk=keys.slice(i,i+500);
        if(chunk.length)await redis.sAdd(setKey,chunk);
      }
    };
    for(let i=0;i<requalAll.length;i+=500){
      const chunk=requalAll.slice(i,i+500);
      if(chunk.length)await redis.sRem(ENRICHED_SET,chunk);
    }
    await Promise.all([
      addChunks(SIZE_READY_PENDING_SET,requalSizeReady),
      addChunks(PENDING_SET,requalRegular),
      addChunks(PRIORITY_PENDING_SET,requalPriority),
      addChunks(RECOVERABLE_PENDING_SET,requalRecoverable)
    ]);
    await redis.set(REQUALIFY_VERSION_KEY,EMAIL_METHOD_VERSION);
    queuedForEnrichment+=requalifyQueued;
  }

  console.log(JSON.stringify({
    event:"law_firm_bootstrap_existing",scanned,qualifiedAdded,qualifiedRemoved,alreadyQualified,
    queuedForEnrichment,requalifyQueued,fullRequalify,
    requalifySizeReady:requalSizeReady.length,requalifyRegular:requalRegular.length,requalifyPriority:requalPriority.length,requalifyRecoverable:requalRecoverable.length,
    historicalQualifiedMarkers
  }));
  return {scanned,qualifiedAdded,qualifiedRemoved,alreadyQualified,queuedForEnrichment,requalifyQueued};
}

async function popSetBatch(setKey,count){
  const out=[];
  for(let i=0;i<count;i++){
    const popped=await redis.sPop(setKey);
    const values=(Array.isArray(popped)?popped:[popped]).filter(Boolean);
    if(!values.length)break;
    out.push(...values);
  }
  return [...new Set(out)].slice(0,count);
}
async function moveToEmailQueue(key,targetSet){
  await Promise.all([
    redis.sRem(SOURCE_PENDING_SET,key),
    redis.sRem(SIZE_READY_PENDING_SET,key),
    redis.sRem(RECOVERABLE_PENDING_SET,key),
    redis.sRem(PRIORITY_PENDING_SET,key),
    redis.sRem(PENDING_SET,key)
  ]);
  if(targetSet)await redis.sAdd(targetSet,key);
}
async function normalizeEmailQueues(){
  const [fresh,sizeReady,recoverable,priority]=await Promise.all([
    redis.sMembers(SOURCE_PENDING_SET),
    redis.sMembers(SIZE_READY_PENDING_SET),
    redis.sMembers(RECOVERABLE_PENDING_SET),
    redis.sMembers(PRIORITY_PENDING_SET)
  ]);
  if(fresh.length){
    await Promise.all(fresh.map(k=>Promise.all([
      redis.sRem(SIZE_READY_PENDING_SET,k),
      redis.sRem(RECOVERABLE_PENDING_SET,k),
      redis.sRem(PRIORITY_PENDING_SET,k),
      redis.sRem(PENDING_SET,k)
    ])));
  }
  if(sizeReady.length){
    await Promise.all(sizeReady.map(k=>Promise.all([
      redis.sRem(RECOVERABLE_PENDING_SET,k),
      redis.sRem(PRIORITY_PENDING_SET,k),
      redis.sRem(PENDING_SET,k)
    ])));
  }
  if(recoverable.length){
    await Promise.all(recoverable.map(k=>Promise.all([
      redis.sRem(PRIORITY_PENDING_SET,k),
      redis.sRem(PENDING_SET,k)
    ])));
  }
  if(priority.length){
    await Promise.all(priority.map(k=>redis.sRem(PENDING_SET,k)));
  }
  console.log(JSON.stringify({event:"law_email_queue_normalized",fresh:fresh.length,sizeReady:sizeReady.length,recoverable:recoverable.length,priority:priority.length}));
}
async function enrichBatch(){
  // Full recovery mode: keep fresh work first, but use all remaining capacity
  // on existing-email / high-signal / recoverable no-site law firms.
  const freshCap=Math.min(8,ENRICH_BATCH);
  const freshKeys=await popSetBatch(SOURCE_PENDING_SET,freshCap);
  const afterFresh=Math.max(0,ENRICH_BATCH-freshKeys.length);
  const sizeReadyKeys=afterFresh?await popSetBatch(SIZE_READY_PENDING_SET,Math.min(32,afterFresh)):[];
  const afterSizeReady=Math.max(0,afterFresh-sizeReadyKeys.length);
  const regularKeys=afterSizeReady?await popSetBatch(PENDING_SET,Math.min(16,afterSizeReady)):[];
  const afterRegular=Math.max(0,afterSizeReady-regularKeys.length);
  const priorityKeys=afterRegular?await popSetBatch(PRIORITY_PENDING_SET,Math.min(16,afterRegular)):[];
  const afterPriority=Math.max(0,afterRegular-priorityKeys.length);
  const recoverableKeys=afterPriority?await popSetBatch(RECOVERABLE_PENDING_SET,afterPriority):[];
  const keys=[...new Set([...freshKeys,...sizeReadyKeys,...regularKeys,...priorityKeys,...recoverableKeys])].slice(0,ENRICH_BATCH);
  if(!keys.length)return 0;
  await Promise.all(keys.map(k=>Promise.all([
    redis.sRem(SOURCE_PENDING_SET,k),
    redis.sRem(SIZE_READY_PENDING_SET,k),
    redis.sRem(RECOVERABLE_PENDING_SET,k),
    redis.sRem(PRIORITY_PENDING_SET,k),
    redis.sRem(PENDING_SET,k)
  ])));
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
        const retrySet=retryEmails.length?PENDING_SET:(emailRecoveryPriority(retryLead)>=3?RECOVERABLE_PENDING_SET:PRIORITY_PENDING_SET);
        await moveToEmailQueue(key,retrySet);
        console.warn(JSON.stringify({event:"law_firm_enrich_retry",key,error:String(error?.message||error)}));
      }
    }
  };
  await Promise.all(Array.from({length:Math.min(ENRICH_CONCURRENCY,keys.length)},()=>run()));
  return done;
}
async function seed(cities){
  const [queue,pendingPriority,pendingSource,pendingSizeReady,pendingRegular,pendingRecoverable]=await Promise.all([
    redis.lLen(ACTIVE_QUEUE),
    redis.sCard(PRIORITY_PENDING_SET),
    redis.sCard(SOURCE_PENDING_SET),
    redis.sCard(SIZE_READY_PENDING_SET),
    redis.sCard(PENDING_SET),
    redis.sCard(RECOVERABLE_PENDING_SET)
  ]);
  if(queue>=QUEUE_HIGH_WATER)return 0;
  const totalEnrichmentBacklog=pendingPriority+pendingSource+pendingSizeReady+pendingRegular+pendingRecoverable;
  if(shouldPauseLawDiscovery({pendingEnrichment:totalEnrichmentBacklog,limit:DISCOVERY_BACKLOG_LIMIT})){
    await redis.hIncrBy(STATS,"discovery_paused_for_enrichment",1);
    return 0;
  }

  const capacity=Math.max(0,Math.min(SEED_BATCH,QUEUE_HIGH_WATER-queue));
  if(!capacity||!cities.length||!PRACTICE_FOCI.length)return 0;

  let cursor=Math.max(0,Number(await redis.get(SEED_CURSOR_KEY)||0));
  let wave=Math.max(0,Number(await redis.get(SEED_WAVE_KEY)||0));
  let added=0,scanned=0;
  const maxScan=Math.max(cities.length*2,capacity*8);

  while(added<capacity&&scanned<maxScan){
    if(cursor>=cities.length){
      cursor=0;
      wave=(wave+1)%PRACTICE_FOCI.length;
      await redis.set(SEED_WAVE_KEY,String(wave));
    }
    const cityIndex=cursor++;
    scanned++;

    const area=cities[cityIndex];
    // Rotate practice by both city and wave so adjacent cities diversify
    // and a city is not revisited for the same practice until a full sweep completes.
    const focus=PRACTICE_FOCI[(cityIndex+wave)%PRACTICE_FOCI.length];
    const areaKey=`${area.state}|${normalize(area.city)}|${focus.key}|w${wave}`;
    if(await redis.sIsMember(SEEDED_SET,areaKey))continue;

    const id=randomUUID();
    const coveragePass=`law-email-v19-w${wave+1}`;
    const job={id,batch_id:"us-law-firm-email-qualified-v7",industry:"LAW_FIRM",search_profile:"law-firm",practice_focus:focus.key,coverage_pass:coveragePass,location:area.location,
      partition_state:area.state,partition_city:area.city,source_population:area.population,target:18,min_score:45,
      require_phone:false,require_email:false,require_contact:false,require_no_website:true,include_no_website:true,
      max_rounds:1,depth:4,status:"queued",phase:"queued",round:0,rounds_completed:0,raw_count:0,unique_count:0,
      qualified_count:0,stored_count:0,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),
      source:"law_firm_pipeline_v7"};

    const claim=await claimCoverage(redis,job,{source:"law_firm_pipeline_v7",practice_focus:focus.key,coverage_pass:coveragePass});
    await redis.sAdd(SEEDED_SET,areaKey);
    if(!claim.claimed)continue;

    await redis.set(`recover:acq:${id}`,JSON.stringify(job),{EX:JOB_TTL});
    await redis.sAdd("recover:acq:index",id);
    await redis.lPush(ACTIVE_QUEUE,id);
    added++;
  }

  await redis.set(SEED_CURSOR_KEY,String(cursor));
  await redis.set(SEED_WAVE_KEY,String(wave));
  if(added)console.log(JSON.stringify({event:"law_firm_seed_frontier",added,cursor,wave,practiceCount:PRACTICE_FOCI.length,cityCount:cities.length}));
  return added;
}

console.log(JSON.stringify({event:"law_firm_pipeline_boot",phase:"bootstrap_existing"}));
await bootstrapExistingQualified();
await normalizeEmailQueues();
console.log(JSON.stringify({event:"law_firm_pipeline_boot",phase:"city_load"}));
const cities=await loadCities();
console.log(JSON.stringify({event:"law_firm_pipeline_boot",phase:"city_loaded",cities:cities.length}));

console.log(JSON.stringify({event:"law_firm_pipeline_started",cities:cities.length,practices:PRACTICE_FOCI.map(x=>x.key),target:TARGET_TOTAL,queueHighWater:QUEUE_HIGH_WATER,seedBatch:SEED_BATCH,enrichBatch:ENRICH_BATCH,enrichConcurrency:ENRICH_CONCURRENCY,discoveryBacklogLimit:DISCOVERY_BACKLOG_LIMIT}));

async function seedLoop(){
  while(true){
    try{
      const seeded=await seed(cities);
      const queue=await redis.lLen(ACTIVE_QUEUE);
      if(seeded)console.log(JSON.stringify({event:"law_firm_seed_cycle",seeded,queue}));
    }catch(error){console.error("law_firm_seed_error",error?.stack||error?.message||error);}
    await sleep(Math.max(1000,Math.min(LOOP_MS,2500)));
  }
}

async function enrichmentLoop(){
  while(true){
    try{
      const enriched=await enrichBatch();
      const [queue,qualified,enrichedTotal,rejected,pending,pendingEmail,pendingRecoverable,pendingSource,websitePending,websiteReady,emailStats]=await Promise.all([
        redis.lLen(ACTIVE_QUEUE),redis.sCard(READY_SET),redis.sCard(ENRICHED_SET),redis.sCard(REJECTED_SET),
        redis.sCard(PENDING_SET),redis.sCard(PRIORITY_PENDING_SET),redis.sCard(RECOVERABLE_PENDING_SET),redis.sCard(SOURCE_PENDING_SET),
        redis.sCard(WEBSITE_AUDIT_PENDING_SET),redis.sCard(WEBSITE_REFRESH_READY_SET),
        redis.hmGet(STATS,["email_existing_hit","email_duck_hit","email_bing_hit","email_zero_cost_hit","email_no_hit","scrapling_source_hit","scrapling_source_fail","email_verifier_unavailable","scrapling_search_hit","bing_source_links","bing_source_pages_matched","bing_source_email_pages","email_raw_candidate_leads","email_identity_mx_pass_leads","email_identity_mx_reject_leads","email_keelead_pass_leads","email_keelead_reject_leads","email_source_verified_leads","jina_source_hit","jina_source_fail"])
      ]);
      console.log(JSON.stringify({
        event:"law_firm_pipeline_cycle",seeded:null,enriched,queue,qualified,enrichedTotal,rejected,pending,pendingEmail,pendingRecoverable,pendingSource,websitePending,websiteReady,
        emailExisting:Number(emailStats?.[0]||0),emailDuck:Number(emailStats?.[1]||0),emailBing:Number(emailStats?.[2]||0),
        emailZeroCost:Number(emailStats?.[3]||0),emailNoHit:Number(emailStats?.[4]||0),
        scraplingSourceHit:Number(emailStats?.[5]||0),scraplingSourceFail:Number(emailStats?.[6]||0),
        emailVerifierUnavailable:Number(emailStats?.[7]||0),scraplingSearchHit:Number(emailStats?.[8]||0),
        bingSourceLinks:Number(emailStats?.[9]||0),bingSourcePagesMatched:Number(emailStats?.[10]||0),
        bingSourceEmailPages:Number(emailStats?.[11]||0),
        emailRawCandidateLeads:Number(emailStats?.[12]||0),emailIdentityMxPassLeads:Number(emailStats?.[13]||0),
        emailIdentityMxRejectLeads:Number(emailStats?.[14]||0),emailKeeleadPassLeads:Number(emailStats?.[15]||0),
        emailKeeleadRejectLeads:Number(emailStats?.[16]||0),emailSourceVerifiedLeads:Number(emailStats?.[17]||0),jinaSourceHit:Number(emailStats?.[18]||0),jinaSourceFail:Number(emailStats?.[19]||0)
      }));
    }catch(error){console.error("law_firm_enrich_loop_error",error?.stack||error?.message||error);}
    await sleep(LOOP_MS);
  }
}

async function websiteAuditLoop(){
  while(true){
    try{
      const audited=await websiteAuditBatch();
      if(audited){
        const [pending,ready]=await Promise.all([
          redis.sCard(WEBSITE_AUDIT_PENDING_SET),
          redis.sCard(WEBSITE_REFRESH_READY_SET)
        ]);
        console.log(JSON.stringify({event:"law_website_audit_cycle",audited,pending,ready}));
      }
    }catch(error){console.error("law_website_audit_loop_error",error?.stack||error?.message||error);}
    await sleep(Math.max(1500,LOOP_MS));
  }
}

await Promise.all([seedLoop(),enrichmentLoop()]);
