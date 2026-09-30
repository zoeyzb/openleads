// deployment trigger: activate law enrichment worker for Chicago MCP validation 2026-09-30
// deployment trigger: law email-v37 current-head snapshot 2026-09-30
import { createClient } from "redis";
import { randomUUID } from "node:crypto";
import { resolveMx } from "node:dns/promises";
import { orchestrate as enrichProfessionalEmail } from "email-enrich";
import { LAW_PRACTICES, lawFirmPracticeAreas, lawFirmPracticeKeys, TARGET_LAW_PRACTICES, qualifiesNoWebsiteLawLead, shouldPauseLawDiscovery, lawResearchQueries, isUsableLawEmail, isLawFirmLead } from "./law-firm-targeting.mjs";
import { campaignLeadSetKey, claimCoverage } from "./acquisition-coverage.mjs";
import { startLawLeadSheetSync } from "./law-sheet-sync.mjs";

const REDIS_URL=process.env.ACQUISITION_REDIS_URL||process.env.REDIS_URL||"";
if(!REDIS_URL) throw new Error("ACQUISITION_REDIS_URL required");
const LAW_LEADS_SHEET_SYNC_ENABLED=String(process.env.LAW_LEADS_SHEET_SYNC_ENABLED||"").toLowerCase()==="true";
const LAW_LEADS_SPREADSHEET_ID=String(process.env.LAW_LEADS_SPREADSHEET_ID||"").trim();
const GOOGLE_SERVICE_ACCOUNT_JSON=String(process.env.GOOGLE_SERVICE_ACCOUNT_JSON||"");
const LAW_LEADS_SHEET_SYNC_INTERVAL_MS=Math.max(60000,Number(process.env.LAW_LEADS_SHEET_SYNC_INTERVAL_MS||120000));

const ZIP_SOURCE_URL=process.env.US_ZIP_SOURCE_URL||"https://raw.githubusercontent.com/ReadyAPIs-com/curated-us-zips/main/data/us-zips.csv";
const TARGET_TOTAL=Math.max(100,Number(process.env.LAW_FIRM_TARGET_TOTAL||25000));
const MAX_CITIES=Math.max(50,Number(process.env.LAW_FIRM_MAX_CITIES||1200));
const QUEUE_HIGH_WATER=Math.max(8,Math.min(64,Number(process.env.LAW_FIRM_QUEUE_HIGH_WATER||24)));
const SEED_BATCH=Math.max(1,Math.min(12,Number(process.env.LAW_FIRM_SEED_BATCH||3)));
const ENRICH_BATCH=Math.max(1,Math.min(64,Number(process.env.LAW_FIRM_ENRICH_BATCH||32)));
const ENRICH_CONCURRENCY=Math.max(1,Math.min(28,Number(process.env.LAW_FIRM_ENRICH_CONCURRENCY||12)));
const EMAIL_METHOD_VERSION="email-v66-yahoo-official-bar-fallback";
const FULL_REQUAL_VERSION=String(process.env.LAW_FULL_REQUAL_VERSION||"eligibility-v1");
const HISTORICAL_RECOVERY_VERSION=String(process.env.LAW_HISTORICAL_RECOVERY_VERSION||"historical-v1");
const CHICAGO_HEADCOUNT_RECOVERY_VERSION="chicago-headcount-v2";
const CHICAGO_HEADCOUNT_RECOVERY_KEY="recover:law-firm:chicago-headcount-recovery-version";
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
  // KeeLead is optional in the clean stack. By the time this function runs,
  // candidates already passed strict firm identity + MX + exact public-source
  // binding. Do not discard a source-verified address just because an optional
  // SMTP verifier service is not deployed.
  if(!KEELEAD_BASE_URL){
    await redis.hIncrBy(STATS,"email_optional_verifier_bypass",1);
    return unique;
  }
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
    // Source + exact identity + MX remain the hard acceptance gates. KeeLead is
    // an optional extra signal; outages must not erase an otherwise usable lead.
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
  let sourceHost="",sourceOrigin="";
  try{
    const parsed=new URL(source);
    sourceHost=parsed.hostname.toLowerCase().replace(/^www\./,"");
    sourceOrigin=parsed.origin;
  }catch{}
  // If the exact published email lives on its own domain, that domain is an
  // owned website signal. Do not require the page to contain an absolute
  // self-link; most normal contact pages use relative navigation.
  for(const domain of domains){
    const cleanDomain=String(domain).toLowerCase().replace(/^www\./,"");
    if(sourceHost&&(sourceHost===cleanDomain||sourceHost.endsWith("."+cleanDomain)||cleanDomain.endsWith("."+sourceHost))){
      return sourceOrigin||("https://"+cleanDomain);
    }
  }
  try{
    const page=await fetchResearchPage(source,lead,key);
    if(!page?.html)return "";
    for(const domain of domains){
      if(sourceLinksToEmailDomain(page.html,domain))return "https://"+domain;
    }
  }catch{}
  return "";
}

async function publishedEmailsOnExactSource(source="",emails=[],lead={},key=""){
  if(!isDirectPublishedEmailSource(source)||!emails.length)return [];
  try{
    const page=await fetchResearchPage(source,lead,key,true);
    if(!page?.html){
      await redis.hIncrBy(STATS,"email_source_binding_page_miss",1);
      return [];
    }
    // contextualEmails is the identity gate: it only emits an address when the
    // surrounding page/email context proves firm/person ownership via exact
    // identity, phone, trusted legal source, or owned-domain affinity.
    // Requiring a second whole-page geo rule here contradicted discovery and
    // rejected valid court/legal-record emails that omit Maps city/state text.
    const finalUrl=page.final_url||source;
    const pageText=stripHtml(page.html).slice(0,50000);
    const identityMatched=pageMatchesLead(pageText,lead,finalUrl);
    const contextual=new Set(contextualEmails(page.html,lead,finalUrl).map(x=>String(x).toLowerCase()));
    const literal=new Set(emailsFrom(page.html).map(x=>String(x).toLowerCase()));
    const rank=lawSourceRank(finalUrl,lead);
    const trustedLiteral=identityMatched&&(rank<=4||legalRecordUrlLikely(finalUrl));
    const matched=emails.filter(email=>{
      const e=String(email).toLowerCase();
      return contextual.has(e)||(trustedLiteral&&literal.has(e));
    });
    if(matched.length&&matched.some(email=>!contextual.has(String(email).toLowerCase()))){
      await redis.hIncrBy(STATS,"email_source_binding_literal_identity_accept",1);
      console.log(JSON.stringify({
        event:"law_email_source_binding_literal_identity_accept",
        key,
        name:String(lead.name||lead.title||""),
        source:String(finalUrl),
        matched:matched.slice(0,3),
        sourceRank:rank
      }));
    }
    if(!matched.length){
      await redis.hIncrBy(STATS,"email_source_binding_exact_email_miss",1);
      console.log(JSON.stringify({
        event:"law_email_source_binding_reject",
        key,
        name:String(lead.name||lead.title||""),
        source:String(finalUrl),
        candidateCount:emails.length,
        publishedContextCount:contextual.size,
        literalEmailCount:literal.size,
        identityMatched,
        sourceRank:rank
      }));
    }
    return matched;
  }catch(error){
    await redis.hIncrBy(STATS,"email_source_binding_fetch_error",1);
    console.warn(JSON.stringify({event:"law_email_source_binding_error",key,error:String(error?.message||error).slice(0,240)}));
    return [];
  }
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
let scraplingBrowserGate=Promise.resolve();
async function withScraplingBrowserSlot(fn){
  const previous=scraplingBrowserGate;
  let release;
  scraplingBrowserGate=new Promise(resolve=>{release=resolve;});
  await previous;
  try{return await fn();}finally{release();}
}
const JINA_READER_ENABLED=String(process.env.JINA_READER_ENABLED||"true").toLowerCase()!=="false";
const JINA_READER_RPM=Math.max(1,Math.min(30,Number(process.env.JINA_READER_RPM||24)));
const JINA_READER_MAX_INFLIGHT=Math.max(1,Math.min(5,Number(process.env.JINA_READER_MAX_INFLIGHT||4)));
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
const CALBAR_ADAPTER_VERSION="calbar-v10-strong-email-accept";
const CALBAR_ADAPTER_VERSION_KEY="recover:law-firm:calbar-adapter-version";
const CANDIDATE_SIZE_RESEARCH_VERSION="candidate-size-v3-direct-lawyercom";
const CANDIDATE_SIZE_RESEARCH_VERSION_KEY="recover:law-firm:candidate-size-research-version";
const HISTORICAL_QUALIFIED_KEYS=new Set(["place:ChIJ-U4jzLpzaYgRiuVOJexcUts","place:ChIJ-cZwjdl814kR3naYgZCQKWI","place:ChIJ205yYu_UyFQRWo9oRpd3T-M","place:ChIJ2ROk0Extq4kRBT2E7-tRYlw","place:ChIJ32Qgyr7wtocRGWTUwdhYGTk","place:ChIJ3QySmg_HmoARkctGxRlocHU","place:ChIJ3W-ACwxx44kR2rru4m1yG4A","place:ChIJ4W_J98Jv54gRGvAwT50QYxA","place:ChIJ4fF-dR4YhYARuNJj2qaVxFc","place:ChIJ5WPlZJCNwokRIEUL9eDQOZw","place:ChIJ5wdWFlsyMYYRWPy3nw0m03A","place:ChIJ5z3GsvfFvIcRO0k17OFS-74","place:ChIJ71pJNPiKR4gRLhF2R_ErKEk","place:ChIJ7cSewURXwokRJYKLE-zxnBw","place:ChIJ7wsutdx4bIcR6p_AksLnRyw","place:ChIJ95gGZEgg6IgRZsn5pby6rpE","place:ChIJ9zP3h5kSAIkRdWMOrKTPeI8","place:ChIJA9HEiW7rJIYR95Qpcp4Lgvg","place:ChIJAQBkSoYo3YARpPJt5RHVTWY","place:ChIJAyCOMGLOw4kR7YvAi7XZ_H4","place:ChIJBVc_u6i2hYARiPAijtV8dAY","place:ChIJD6vum6RfQogRdNScZ6vQ5Zs","place:ChIJDyWvCZZXwokRTcTR4Oj1oKQ","place:ChIJE4PSX6raxokR91IKiYlqp9k","place:ChIJF31O_YIEU4cRpSPVKS9wwtY","place:ChIJFU2oKxYzMYYRebQBKdNNm0g","place:ChIJG1VBA1HxNIgRGAJy-YLCIhI","place:ChIJGWLs2eTQhIARV7GeoY81EcE","place:ChIJH8ORLCxfVFMRiTs-1FsCUGk","place:ChIJHfJFQjomwokRSql3ngElZ5M","place:ChIJIXOHPySX-IgRBKF_bc-rke0","place:ChIJJzoh2FyGmYcRN71FnFcpY00","place:ChIJK7eQx4j5Y4gRb9qliaeIfQg","place:ChIJKYY8pmLnmoARE4mULG2YnNs","place:ChIJKer573eoZYYRC-qFdZ_Eg3A","place:ChIJKw02pnLRhIARPEIfaW4NNg0","place:ChIJLTBYQhSrw4kRMnKH-0QzcG8","place:ChIJLyxfboWMk4cRf66FH6ritxo","place:ChIJM02Gea1YXIYRyvJ5ZwPhoQw","place:ChIJM6BqOO0wq4kRTae0vIkDBVo","place:ChIJM_1lHE5ZVFMRwH1fHLVGt34","place:ChIJMbp75upAwFQRe2uTudVjsow","place:ChIJN7r7r72awoARjAesAtfbDLw","place:ChIJNycr3iOHmYcRXquelBr03KE","place:ChIJO7QVTAluAHwRVsaeyJtxK7A","place:ChIJO7lK00vF54gRQ8j3zzWyLwU","place:ChIJPRt57X_d9YgRI5UYwRJE_2U","place:ChIJQ3oMBtrRUIgR65BnUyVPft4","place:ChIJRVH9a48Tt4cR6SOOdv3Edck","place:ChIJRW1H7r3VFogRlFoHqpncZ0I","place:ChIJRYrj7X3pwogRdG_E9PJYcf0","place:ChIJTa7FEGNQ4IYRSydBoKqsl2o","place:ChIJUYXwNCnaNYgRjAdaoH_ogLw","place:ChIJVYdWQ-4Cw4kRr4bAd6NLQVY","place:ChIJVxw7O9jeJIgR1FiEkRQhZLI","place:ChIJY6aHQLRcfYcRKiqiFK5w0do","place:ChIJayky0_XFvIcRjdDZMkHLRD8","place:ChIJb2hcRZsU3okR_EKIIlGOyw8","place:ChIJb3hWSBZv_4gROY_ApeSM8wU","place:ChIJbxKvvzbu2YkRMdteRtp7klE","place:ChIJd1aP8_KVlocR8_cIhc_Dsd0","place:ChIJdTzQCQJ5hYARdGR1UtB9dkE","place:ChIJeXm0tUXM3IARGzqfb3eOmCY","place:ChIJf2DHHpm3D4gRXfghePyBLmk","place:ChIJfyFrYXdVwIcRYhnjhZT1owA","place:ChIJgx6wDyjpaIgRAC-jEra5Hjw","place:ChIJi87TdvdvwokRjr-8f8K3FG0","place:ChIJjcnM45EgnYgREsRlrRsiyGg","place:ChIJkTUAzFFwzoARxKluSnPRdWQ","place:ChIJl6VxtjJBZIgRBc4VIABoDiw","place:ChIJmbFHSgiQhYAR0v11xfpj4bw","place:ChIJn5Qcag_1UocRtfKl2ZxDBug","place:ChIJnQ8ijF_v44kRFNChrD1otkQ","place:ChIJo-hS02IU7IARMFpv8tr4RTY","place:ChIJpWJorhCs0IkRRcYffMNkoeI","place:ChIJqSz5ytfMwoARZvRZn84vWmI","place:ChIJr104108HYIgRkJT9GlF7xKw","place:ChIJs4frIbQakFQRQPUW66WTiH4","place:ChIJsRDfI5BBZIgR4v0gkMlYNgA","place:ChIJsewYiPRp6oAR6fKhe5QIWcY","place:ChIJt4aEWsHfyFYRT_jYSgVRVw4","place:ChIJt9fh31NZ54YR5ZyCFBn9ock","place:ChIJtRjaRPXgtYcR2V6WyoGvW6g","place:ChIJuzD2vZYT2YkR7dqgvdWC6DY","place:ChIJxUWzCxINkIARDdm6uFNIS-E","place:ChIJzWyZs58FU4gR5-_YQva8wr4"]);
const REJECTED_SET="recover:law-firm:rejected:v3";
const PENDING_SET="recover:law-firm:enrich-pending:v3";
const SIZE_READY_PENDING_SET="recover:law-firm:size-ready-pending:v1";
const PRIORITY_PENDING_SET="recover:law-firm:enrich-priority:v3";
const RECOVERABLE_PENDING_SET="recover:law-firm:enrich-recoverable:v1";
const SOURCE_PENDING_SET="recover:law-firm:enrich-pending:v2";
const CHICAGO_PENDING_SET="recover:law-firm:chicago-priority:v1";
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
  if(/\b(?:law firm|law offices|pllc|p\.c\.|pc|p\.a\.|pa|llp|apc|professional corporation)\b/i.test(name))return "firm";
  if(/^the?\s*law office of\s+[A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){1,4}$/i.test(name)||
     /\battorney(?:\s+at\s+law)?\b/i.test(name)||
     /^[A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){1,3}(?:,?\s+Esq\.?)?$/i.test(name))return "solo";
  return "unknown";
}
function highValueLawResearchLead(lead={}){
  // Once an email is already source-verified, proving 2-10 attorneys is the
  // remaining money gate. Allow deeper reads for that tiny conversion cohort
  // even when the business name looks solo/ambiguous.
  if(lead.conversion_headcount_priority===true)return true;
  const shape=lawFirmNameShape(lead);
  // Paid cohort is 2-10 attorneys. Multi/firm-shaped names are the highest-value
  // candidates even when Maps metadata is sparse, so they always qualify for
  // the deeper public-page/browser research lane.
  return shape==="multi"||shape==="firm";
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
    const isCalBar=/https?:\/\/apps\.calbar\.ca\.gov\/attorney\//i.test(String(url||""));
    const requestHeaders=isCalBar?{
      "user-agent":"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
      "accept":"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "accept-language":"en-US,en;q=0.9",
      "cache-control":"no-cache",
      "pragma":"no-cache",
      "upgrade-insecure-requests":"1"
    }:{"user-agent":"Mozilla/5.0 (compatible; RecoverResearch/1.0)","accept":"text/html,application/xhtml+xml"};
    const r=await fetch(url,{signal:ctl.signal,redirect:"follow",headers:requestHeaders});
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
async function callScrapling(url,{allowBrowser=true}={}){
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
    await fetch(SCRAPLING_MCP_URL,{
      method:"POST",headers:sessionHeaders,
      body:JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"}),
      signal:AbortSignal.timeout(4000)
    });

    const invoke=async(name,args,timeoutMs)=>{
      const response=await fetch(SCRAPLING_MCP_URL,{
        method:"POST",headers:sessionHeaders,signal:AbortSignal.timeout(timeoutMs),
        body:JSON.stringify({jsonrpc:"2.0",id:name==="make_request"?2:3,method:"tools/call",params:{name,arguments:args}})
      });
      const payload=parseRemoteMcpPayload(await response.text());
      if(!response.ok)throw new Error(name+" "+response.status);
      const result=payload?.result||{};
      const structured=result?.structuredContent||{};
      if(result?.isError===true)return null;
      let content=structured?.content;
      if(!content){
        const rawText=result?.content?.[0]?.text;
        if(rawText){try{content=JSON.parse(rawText)?.content;}catch{}}
      }
      const text=Array.isArray(content)?content.filter(Boolean).join("\n"):String(content||"");
      if(!text.trim())return null;
      return {
        html:text.slice(0,1000000),
        elapsed_ms:0,
        final_url:String(structured?.url||url),
        status:Number(structured?.status||200)
      };
    };

    // Use Scrapling's static browser-impersonating HTTP client first. It does not
    // spawn Patchright/Chromium and therefore avoids Railway's thread ceiling.
    try{
      const staticResult=await invoke("make_request",{
        url,
        method:"GET",
        impersonate:"chrome",
        extraction_type:"html",
        main_content_only:false,
        timeout:12,
        retries:2,
        follow_redirects:"safe",
        stealthy_headers:true
      },16000);
      if(staticResult?.html){
        await redis.hIncrBy(STATS,"scrapling_static_hit",1);
        return {...staticResult,via:"scrapling_static"};
      }
    }catch{
      await redis.hIncrBy(STATS,"scrapling_static_fail",1);
    }

    // Browser stealth is reserved for the tiny post-email/headcount cohort.
    // During broad email discovery, static/Jina/direct reads are enough and keep
    // one blocked source from consuming the entire per-lead time budget.
    if(allowBrowser){
      try{
        const stealth=await withScraplingBrowserSlot(()=>invoke("stealthy_fetch",{
          url,
          extraction_type:"html",
          main_content_only:false,
          headless:true,
          network_idle:false,
          disable_resources:true,
          timeout:12000
        },16000));
        if(stealth?.html){
          await redis.hIncrBy(STATS,"scrapling_browser_hit",1);
          return {...stealth,via:"scrapling_browser"};
        }
      }catch{
        await redis.hIncrBy(STATS,"scrapling_browser_fail",1);
      }
    }else{
      await redis.hIncrBy(STATS,"scrapling_browser_skip",1);
    }
    return null;
  }catch(error){
    const failures=await redis.hIncrBy(STATS,"scrapling_source_fail",1);
    if(failures<=3||failures%100===0)console.warn(JSON.stringify({event:"law_scrapling_fail",failures,error:String(error?.message||error).slice(0,220)}));
    return null;
  }finally{clearTimeout(initTimer);}
}
async function callJinaReader(url,lead={}){
  if(!JINA_READER_ENABLED||!url||(lawSourceRank(url,lead)>4&&!/\\.pdf(?:$|[?#])/i.test(String(url))))return null;
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
  const directMatches=Boolean(direct?.html&&pageMatchesLead(directText,lead,direct?.final_url||url));
  if(direct?.html&&isDirectCalBarProfile(direct?.final_url||url)&&!directMatches){
    await redis.hIncrBy(STATS,"calbar_profile_identity_reject",1);
    console.log(JSON.stringify({
      event:"law_calbar_profile_identity_reject",
      key,
      name:String(lead.name||lead.title||""),
      person:String(likelyAttorneyName(lead)||""),
      city:String(normalizedLeadCity(lead)||""),
      source:String(direct?.final_url||url)
    }));
  }
  const directEvidence=directMatches&&(
    contextualEmails(direct.html,lead,url).length>0 ||
    attorneyEstimate(direct.html,directText)>0
  );
  if(directEvidence)return direct;
  // Strong identity (name/phone/state) is enough to justify a deeper read.
  // Many real 2-10 attorney firms look "solo" from the Maps business name.
  const shouldDeepRead=highValueLawResearchLead(lead)||emailRecoveryPriority(lead)>=5;
  if(allowStealth&&shouldDeepRead){
    const rank=lawSourceRank(url,lead);
    const isPdf=/\.pdf(?:$|[?#])/i.test(String(url));
    const conversion=lead.conversion_headcount_priority===true;
    if(isDirectCalBarProfile(url))await redis.hIncrBy(STATS,"direct_calbar_deep_read_attempt",1);
    const jina=await callJinaReader(url,lead);
    if(jina?.html){
      const fullJinaText=stripHtml(jina.html);
      const directCalBar=isDirectCalBarProfile(url);
      const jinaText=directCalBar?fullJinaText.slice(0,220000):fullJinaText.slice(0,24000);
      if(directCalBar){
        const normalizedJina=String(jinaText||"");
        const profileIdx=normalizedJina.search(/Attorney\s+Profile/i);
        const statusIdx=normalizedJina.search(/License\s+Status/i);
        const emailIdx=normalizedJina.search(/Email\s*(?::|-)?/i);
        const websiteIdx=normalizedJina.search(/Website\s*(?::|-)?/i);
        await redis.hIncrBy(STATS,"direct_calbar_deep_read_chars",Math.min(500000,normalizedJina.length));
        console.log(JSON.stringify({
          event:"law_calbar_deep_read_diagnostic",
          key,
          name:String(lead.name||lead.title||""),
          source:String(jina?.final_url||url),
          chars:normalizedJina.length,
          profileIdx,statusIdx,emailIdx,websiteIdx,
          person:String(likelyAttorneyName(lead)||"")
        }));
      }
      if(pageMatchesLead(jinaText,lead,jina?.final_url||url)){
        if(directCalBar)await redis.hIncrBy(STATS,"direct_calbar_deep_read_match",1);
        return jina;
      }
    }
    // Broad email discovery needs Scrapling's lightweight HTTP client too.
    // Use static Scrapling for any promising legal source; reserve Chromium
    // stealth only for the tiny post-email conversion/headcount cohort.
    const scrapling=await callScrapling(url,{allowBrowser:conversion});
    if(scrapling?.html){
      const scraplingText=stripHtml(scrapling.html).slice(0,36000);
      if(pageMatchesLead(scraplingText,lead,scrapling?.final_url||url)){
        const scraplingEmails=contextualEmails(scrapling.html,lead,scrapling?.final_url||url);
        const scraplingAttorneys=attorneyEstimate(scrapling.html,scraplingText);
        if(scraplingEmails.length||scraplingAttorneys>0||conversion){
          await redis.hIncrBy(STATS,"scrapling_source_hit",1);
          return scrapling;
        }
      }
    }
    if(!conversion)await redis.hIncrBy(STATS,"scrapling_broad_discovery_miss",1);
  }
  return directMatches?direct:null;
}
function stripHtml(html=""){
  return String(html).replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ")
    .replace(/<[^>]+>/g," ").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/\s+/g," ").trim();
}
function emailsFrom(text=""){
  const source=normalizePublishedEmailText(text);
  return [...new Set((source.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig)||[])
    .map(x=>x.toLowerCase().replace(/[),.;:]+$/,""))
    .filter(isUsableLawEmail))].slice(0,8);
}
function likelyAttorneyName(lead={}){
  const explicitRaw=String(lead.owner_name||"").replace(/\s+/g," ").trim();
  const explicit=explicitRaw
    .replace(/\s*\((?:owner|attorney|lawyer|partner|principal|founder|manager|member)\)\s*$/i,"")
    .replace(/\s*[-–—|]\s*(?:owner|attorney|lawyer|partner|principal|founder|manager|member)\s*$/i,"")
    .trim();
  const explicitLooksLikeFirm=/\b(law offices?|law office|law firm|attorneys? at law|legal group|legal services|llc|pllc|p\.?c\.?|llp|apc)\b/i.test(explicit);
  const explicitGenericRole=/^(?:at law|attorney at law|attorney|lawyer|owner|partner|principal|founder|manager|member)$/i.test(explicit);
  if(explicitRaw&&(explicitLooksLikeFirm||explicitGenericRole))void redis.hIncrBy(STATS,"owner_name_firm_label_bypass",1).catch(()=>{});
  if(explicit&&!explicitLooksLikeFirm&&!explicitGenericRole&&explicit.split(/\s+/).length>=2&&explicit.split(/\s+/).length<=5)return explicit;
  const raw=String(lead.name||lead.title||"").replace(/\s+/g," ").trim();
  if(!raw)return "";
  const patterns=[
    /^([A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){1,4}),?\s+(?:esq\.?\s*)?attorney\s+at\s+law\b/i,
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
      const looksLikeFirm=/\b(law offices?|law office|law firm|attorneys? at law|legal group|legal services|llc|pllc|p\.?c\.?|llp|apc|group|associates)\b/i.test(name);
      const genericRole=/^(?:at law|attorney at law|attorney|lawyer)$/i.test(name);
      if(!looksLikeFirm&&!genericRole&&name.split(/\s+/).length>=2&&name.split(/\s+/).length<=5)return name;
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
  const stop=new Set(["law","laws","firm","firms","office","offices","attorney","attorneys","lawyer","lawyers","llc","pllc","pc","pa","group","associates","the","and","prof","professional","corp","corporation","inc","incorporated","company","co","practice","services"]);
  return [...new Set(normalize(lead.name||lead.title||"").split(" ").filter(x=>x.length>=3&&!stop.has(x)))].slice(0,6);
}
function isDirectCalBarProfile(url=""){
  return /apps\.calbar\.ca\.gov\/attorney\/Licensee\/Detail\/\d+/i.test(String(url||""));
}
function calBarProfileStatusActive(text=""){
  // CalBar renders the label/value differently across raw HTML, Jina markdown,
  // and browser-rendered pages. Accept optional punctuation/whitespace but still
  // require the explicit Active value.
  return /License\s+Status\s*(?::|-)?\s*Active\b/i.test(String(text||""));
}
function calBarPublishedWebsite(text=""){
  const m=String(text||"").match(/Website\s*(?::|-)?\s*(?!Not\s+Available\b)(https?:\/\/[^\s<"'|]+|www\.[^\s<"'|]+)/i);
  if(!m?.[1])return "";
  const value=String(m[1]).replace(/[),.;]+$/,"");
  return /^https?:\/\//i.test(value)?value:"https://"+value;
}
function calBarProfileMatchesLead(text="",lead={},sourceUrl=""){
  if(!isDirectCalBarProfile(sourceUrl))return null;
  if(!calBarProfileStatusActive(text)&&!isActiveCalBarProfile(sourceUrl))return false;
  const raw=String(text||"");
  const digits=raw.replace(/\D/g,"");
  const phone=String(lead.phone||"").replace(/\D/g,"").slice(-10);
  if(phone&&digits.includes(phone))return true;

  const plain=normalize(raw);
  const city=normalize(normalizedLeadCity(lead));
  const variants=attorneyNameVariants(lead)
    .map(v=>normalize(v))
    .filter(Boolean);
  let matchedVariant="",strongNameMatch=false;
  for(const v of variants){
    const tokens=v.split(" ").filter(Boolean);
    if(tokens.length<2)continue;
    // Middle initials frequently differ from CalBar's full middle name
    // (e.g. "Timothy A. Lundell" vs "Timothy Arthur Lundell").
    // Require first + last; treat middle tokens as optional corroboration.
    const first=tokens[0].replace(/[^a-z]/g,"");
    const last=tokens[tokens.length-1].replace(/[^a-z]/g,"");
    if(first.length<2||last.length<2)continue;
    if(!plain.includes(first)||!plain.includes(last))continue;
    matchedVariant=v;
    const substantiveMiddle=tokens.slice(1,-1)
      .map(x=>x.replace(/[^a-z]/g,""))
      .filter(x=>x.length>=3);
    strongNameMatch=tokens.length>=3||substantiveMiddle.some(x=>plain.includes(x));
    break;
  }
  if(!matchedVariant)return false;

  // Three-part names are strong enough on an authoritative CalBar profile even
  // when the profile spells out a middle name that Maps stores as an initial.
  if(strongNameMatch)return true;

  // Two-token names are more collision-prone. A deterministic CalBar search
  // returning exactly one profile is sufficient; otherwise keep geo/phone guards.
  if(isUniqueCalBarProfile(sourceUrl))return true;
  if(city&&plain.includes(city))return true;
  if(phone)return false;
  return !city;
}
function pageMatchesLead(text="",lead={},sourceUrl=""){
  const plain=normalize(text);
  if(!plain)return false;
  const calBarMatch=calBarProfileMatchesLead(text,lead,sourceUrl);
  if(calBarMatch!==null)return calBarMatch;
  const digits=String(text).replace(/\D/g,"");
  const phone=String(lead.phone||"").replace(/\D/g,"").slice(-10);
  if(phone&&digits.includes(phone))return true;

  const fullName=normalize(lead.name||lead.title||"");
  if(fullName.length>=10&&plain.includes(fullName))return true;

  const city=normalize(normalizedLeadCity(lead));
  const state=normalize(normalizedStateCode(lead)||lead.region||lead.state||lead.state_code||"");
  const geoMatch=Boolean((city&&plain.includes(city))||(state&&state.length>=2&&plain.includes(state)));

  const person=normalize(likelyAttorneyName(lead));
  const personTokens=person.split(" ").filter(x=>x.length>=3);
  if(personTokens.length>=2&&personTokens.every(x=>plain.includes(x))&&geoMatch)return true;

  const tokens=leadNameTokens(lead).filter(x=>x.length>=4);
  if(tokens.length<2)return false;
  const hits=tokens.filter(x=>plain.includes(x)).length;
  return hits>=Math.min(3,tokens.length)&&geoMatch;
}
function sourcePageMatchesFirmIdentity(text="",lead={},sourceUrl=""){
  const plain=normalize(text);
  if(!plain)return false;
  const digits=String(text).replace(/\D/g,"");
  const phone=String(lead.phone||"").replace(/\D/g,"").slice(-10);
  if(phone&&digits.includes(phone))return true;

  const city=normalize(normalizedLeadCity(lead));
  const state=normalize(normalizedStateCode(lead)||lead.region||lead.state||lead.state_code||"");
  const geoMatch=Boolean((city&&plain.includes(city))||(state&&state.length>=2&&plain.includes(state)));

  const fullName=normalize(lead.name||lead.title||"");
  const person=normalize(likelyAttorneyName(lead));
  const trusted=trustedLawSource(sourceUrl,lead);

  // On expected bar/court/government/legal-registry sources, exact published
  // identity is sufficient even when the page omits Maps city/state metadata.
  // Generic directories still require phone or geographic corroboration.
  if(trusted){
    if(fullName.length>=8&&plain.includes(fullName))return true;
    const personTokens=person.split(" ").filter(x=>x.length>=3);
    if(personTokens.length>=2&&personTokens.every(x=>plain.includes(x)))return true;
  }

  if(fullName.length>=8&&plain.includes(fullName)&&geoMatch)return true;
  const tokens=leadNameTokens(lead).filter(x=>x.length>=4);
  const hits=tokens.filter(x=>plain.includes(x)).length;
  if(tokens.length>=2&&hits>=2&&geoMatch)return true;
  if(tokens.length===1&&hits===1&&city&&state&&plain.includes(city)&&plain.includes(state))return true;
  return false;
}
function ownedWebsiteFromMatchedPage(url="",text="",lead={}){
  const rank=lawSourceRank(url,lead);
  if(rank<=4||rank>=90)return "";
  const host=hostOf(url);
  if(!host||/\.pdf(?:$|[?#])/i.test(String(url)))return "";
  const plain=normalize(text);
  const phone=String(lead.phone||"").replace(/\D/g,"").slice(-10);
  const phoneMatch=Boolean(phone&&String(text).replace(/\D/g,"").includes(phone));
  const city=normalize(normalizedLeadCity(lead));
  const state=normalize(normalizedStateCode(lead)||lead.region||lead.state||lead.state_code||"");
  const geoMatch=Boolean((city&&plain.includes(city))||(state&&state.length>=2&&plain.includes(state)));
  const tokens=leadNameTokens(lead).filter(x=>x.length>=4);
  const hostStem=host.replace(/[^a-z0-9]/g,"");
  const domainAffinity=tokens.some(t=>tokenAffinity(hostStem,t));
  const tokenHits=tokens.filter(t=>plain.includes(t)).length;
  const identityTokens=tokens.length===1?tokenHits>=1:tokenHits>=Math.min(2,tokens.length);
  // Unknown rank-6 domains can be acronym/brand domains that do not share
  // obvious tokens with the Maps business name. Exact firm identity + exact
  // phone on the page is strong enough to identify the firm's own site.
  const fullName=normalize(lead.name||lead.title||"");
  const exactFirmName=Boolean(fullName.length>=8&&plain.includes(fullName));
  if(exactFirmName&&phoneMatch)return "https://"+host;
  // Otherwise retain domain-affinity protection so copied directory pages are
  // not mislabeled as owned websites.
  if(domainAffinity&&identityTokens&&phoneMatch)return "https://"+host;
  if(domainAffinity&&identityTokens&&geoMatch)return "https://"+host;
  return "";
}
function knownThirdPartyDirectoryHost(url=""){
  const host=hostOf(url);
  return /(?:^|\.)(?:reachattorneys\.com|lawyer\.com|lawyers\.com|martindale\.com|avvo\.com|justia\.com|findlaw\.com|superlawyers\.com|attorneydir\.com|lawyer-map\.com|allbiz\.com|chamberofcommerce\.com|manta\.com|bbb\.org|yellowpages\.com|yelp\.com|birdeye\.com|mapquest\.com)$/i.test(host);
}
function ownedDomainAffinity(url="",lead={}){
  const host=hostOf(url).replace(/[^a-z0-9]/g,"");
  if(!host)return false;
  const tokens=leadNameTokens(lead).filter(x=>x.length>=4);
  return tokens.some(t=>tokenAffinity(host,t));
}
const FREE_MAIL_DOMAINS=new Set([
  "gmail.com","yahoo.com","hotmail.com","outlook.com","aol.com","icloud.com","me.com","msn.com",
  "proton.me","protonmail.com","live.com","comcast.net","att.net","bellsouth.net","verizon.net",
  "sbcglobal.net","earthlink.net","cs.com","vcn.com","rr.com","maine.rr.com","roadrunner.com","charter.net",
  "spectrum.net","cox.net","optonline.net","frontier.com","centurylink.net","windstream.net"
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
  const state=normalizedStateCode(lead);
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
function decodeCloudflareEmail(encoded=""){
  const hex=String(encoded||"").trim();
  if(!hex||hex.length<4||hex.length%2!==0)return "";
  try{
    const key=parseInt(hex.slice(0,2),16);
    if(!Number.isFinite(key))return "";
    let out="";
    for(let i=2;i<hex.length;i+=2){
      const value=parseInt(hex.slice(i,i+2),16);
      if(!Number.isFinite(value))return "";
      out+=String.fromCharCode(value^key);
    }
    return out;
  }catch{return "";}
}
function normalizePublishedEmailText(value=""){
  let text=String(value||"");
  text=text.replace(/data-cfemail=["']([0-9a-f]+)["']/ig,(m,hex)=>{
    const decoded=decodeCloudflareEmail(hex);
    return decoded?`${m} ${decoded}`:m;
  });
  try{text=decodeURIComponent(text.replace(/\+/g,"%20"));}catch{}
  return text
    .replace(/&#64;|&commat;/gi,"@")
    .replace(/&#46;|&period;/gi,".")
    .replace(/\s*(?:\[at\]|\(at\)|\{at\})\s*/gi,"@")
    .replace(/\s+(?:at)\s+/gi,"@")
    .replace(/\s*(?:\[dot\]|\(dot\)|\{dot\})\s*/gi,".")
    .replace(/\s+(?:dot)\s+/gi,".");
}
function calBarEmailCandidateStrong(email="",lead={}){
  const value=String(email||"").toLowerCase().trim();
  const [local="",domain=""]=value.split("@");
  if(!local||!domain)return false;
  const person=normalize(likelyAttorneyName(lead));
  const personTokens=person.split(" ").filter(x=>x.length>=3);
  const nameTokens=leadNameTokens(lead).filter(x=>x.length>=4);
  const localStem=normalize(local).replace(/\s+/g,"");
  const domainStem=domain.split(".")[0].replace(/[^a-z0-9]/g,"");
  const localIdentity=personTokens.some(t=>localStem.includes(t))||nameTokens.some(t=>localStem.includes(t));
  const domainIdentity=nameTokens.some(t=>tokenAffinity(domainStem,t))||personTokens.some(t=>tokenAffinity(domainStem,t));
  return localIdentity||domainIdentity||FREE_MAIL_DOMAINS.has(domain);
}

function contextualEmails(text="",lead={},sourceUrl=""){
  const raw=normalizePublishedEmailText(text),out=[];
  const re=/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
  let all=[...raw.matchAll(re)]
    .map(m=>({email:String(m[0]||"").toLowerCase().replace(/[),.;:]+$/,""),index:m.index||0}))
    .filter(x=>isUsableLawEmail(x.email)&&!isThirdPartyEmailDomain(x.email));
  const isCalBar=/apps\.calbar\.ca\.gov$/i.test(hostOf(sourceUrl));
  if(isCalBar){
    const before=all.length;
    all=all.filter(x=>calBarEmailCandidateStrong(x.email,lead));
    if(before>all.length)void redis.hIncrBy(STATS,"calbar_decoy_email_reject",before-all.length).catch(()=>{});
  }
  const uniqueAll=[...new Set(all.map(x=>x.email))];
  const fullPageMatch=pageMatchesLead(raw,lead,sourceUrl);
  const fullPhoneMatch=contextHasExactPhone(raw,lead);
  const trustedSource=trustedLawSource(sourceUrl,lead);

  // CalBar is authoritative and intentionally injects email-shaped decoys.
  // If the exact active profile identity matched and an address survived the
  // attorney-aware anti-decoy filter, accept that published address directly.
  // Owned-site checks and MX/KeeLead validation still happen later.
  if(isCalBar&&fullPageMatch&&uniqueAll.length){
    void redis.hIncrBy(STATS,"calbar_strong_email_accept",1).catch(()=>{});
    console.log(JSON.stringify({
      event:"law_calbar_strong_email_accept",
      name:String(lead.name||lead.title||""),
      source:String(sourceUrl||""),
      emails:uniqueAll.slice(0,4)
    }));
    return uniqueAll.slice(0,8);
  }

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
    ...plain.matchAll(/\b(?:attorneys|lawyers)\s*[:#-]\s*(\d{1,3})\b/gi),
    ...plain.matchAll(/\bfirm\s+size\s*:?\s*(\d{1,3})\s+(?:attorneys|lawyers)?\b/gi),
    ...plain.matchAll(/\b(?:size|team size)\s*[:#-]\s*(\d{1,3})\s+(?:attorneys|lawyers)\b/gi),
    ...plain.matchAll(/\b(?:firm|office)\s+(?:has|employs|includes|consists of|is made up of)\s+(\d{1,3})\s+(?:attorneys|lawyers)\b/gi),
    ...plain.matchAll(/\b(?:there\s+(?:is|are)|this\s+(?:office|firm)\s+has)\s+(\d{1,3})\s+(?:attorneys?|lawyers?)\b/gi),
    ...plain.matchAll(/\bhas\s+(\d{1,3})\s+(?:attorneys?|lawyers?)\s+(?:at\s+this\s+(?:location|office)|in\s+this\s+(?:firm|office))\b/gi),
    ...plain.matchAll(/\b(?:law\s+office|law\s+firm|office|firm)\s+with\s+(\d{1,3})\s+(?:attorneys?|lawyers?)\b/gi),
    ...plain.matchAll(/\b(\d{1,3})\s+(?:attorneys|lawyers)\s+(?:at|with|in)\s+(?:the\s+|this\s+)?(?:firm|office)\b/gi)
  ].map(m=>Number(m[1])).filter(n=>n>0&&n<=500);

  const ranges=[
    ...plain.matchAll(/\bfirm\s+size\s*:?\s*(\d{1,2})\s*(?:to|[-–])\s*(\d{1,2})\b/gi),
    ...plain.matchAll(/\b(?:attorneys|lawyers)\s*[:#-]\s*(\d{1,2})\s*(?:to|[-–])\s*(\d{1,2})\b/gi),
    ...plain.matchAll(/\b(\d{1,2})\s*(?:to|[-–])\s*(\d{1,2})\s+(?:attorneys|lawyers)\b/gi)
  ].map(m=>[Number(m[1]),Number(m[2])])
    .filter(([lo,hi])=>lo>0&&hi>=lo&&hi<=100);

  const candidates=[...exact];
  for(const [lo,hi] of ranges){
    // A 1-5 bucket is not enough to prove the firm has at least 2 attorneys.
    candidates.push(lo>=2?hi:1);
  }
  if(/\bfirm\s+size\s*:?\s*(?:solo|sole\s+practi(?:tioner|oner))\b/i.test(plain))candidates.push(1);
  if(!candidates.length)return 0;

  // Be conservative across conflicting explicit evidence: use the largest count,
  // so any 11+ evidence prevents an accidental 2-10 qualification.
  return Math.min(500,Math.max(...candidates));
}
function lawyerComCandidateFirmUrls(lead={}){
  const raw=String(lead.name||lead.title||"")
    .replace(/\b(?:esq(?:uire)?|attorney\s+at\s+law)\b\.?/ig," ")
    .replace(/\b(?:llc|pllc|pc|p\.c\.|apc|llp|pa|p\.a\.)\b/ig," ")
    .replace(/[^a-z0-9]+/gi," ")
    .trim().toLowerCase();
  if(!raw)return [];
  const slug=raw.replace(/\s+/g,"-");
  const state=normalizedStateCode(lead).toLowerCase();
  const stripped=slug
    .replace(/^the-/,"")
    .replace(/^law-offices?-of-/,"")
    .replace(/^law-firm-of-/,"");
  return [...new Set([
    `https://www.lawyer.com/firm/${slug}.html`,
    `https://www.lawyer.com/firm/law-offices-of-${stripped}.html`,
    `https://www.lawyer.com/firm/law-office-of-${stripped}${state?"-"+state:""}.html`
  ])];
}
async function verifyOwnedWebsiteCandidate(url="",lead={}){
  if(!/^https?:\/\//i.test(String(url||"")))return "";
  try{
    const page=await fetchResearchPage(String(url),lead,String(lead.place_id||lead.key||"")?("place:"+String(lead.place_id||"")):"");
    if(!page?.html)return "";
    const finalUrl=String(page.final_url||url);
    const text=stripHtml(page.html).slice(0,50000);
    const phone=String(lead.phone||"").replace(/\D/g,"").slice(-10);
    const phoneMatch=Boolean(phone&&String(text).replace(/\D/g,"").includes(phone));
    if(!pageMatchesLead(text,lead,finalUrl)&&!phoneMatch)return "";
    return ownedWebsiteFromMatchedPage(finalUrl,text,lead)||new URL(finalUrl).origin;
  }catch{return "";}
}

async function directDirectorySizeEvidence(lead={},key=""){
  const name=String(lead.name||lead.title||"").replace(/"/g,"").trim();
  if(!name)return {count:0,source:"",website:""};
  const queries=[
    `site:lawyers.com "${name}"`,
    `site:martindale.com "${name}"`
  ];
  const resultPages=[];
  for(const query of queries){
    try{
      const [htmlResult,rssResult]=await Promise.allSettled([
        fetchText("https://www.bing.com/search?q="+encodeURIComponent(query),4500),
        fetchText("https://www.bing.com/search?format=rss&q="+encodeURIComponent(query),4500)
      ]);
      const html=htmlResult.status==="fulfilled"?String(htmlResult.value?.html||""):"";
      const rss=rssResult.status==="fulfilled"?String(rssResult.value?.html||""):"";
      for(const url of [...new Set([...bingResultLinks(html),...bingRssResultLinks(rss)])]){
        const host=hostOf(url);
        if(!/(^|\.)(?:lawyers|martindale)\.com$/i.test(host))continue;
        if(!resultPages.includes(url))resultPages.push(url);
        if(resultPages.length>=8)break;
      }
    }catch{}
  }
  for(const url of resultPages){
    try{
      const page=await fetchText(url,5500);
      if(!page?.html)continue;
      const source=String(page.final_url||url);
      const text=stripHtml(page.html).slice(0,70000);
      if(!pageMatchesLead(text,lead,source))continue;
      const count=attorneyEstimate(page.html,text);
      const websiteCandidate=outboundFirmWebsiteFromDirectory(page.html,lead);
      const website=websiteCandidate?await verifyOwnedWebsiteCandidate(websiteCandidate,lead):"";
      if(count>0){
        await redis.hIncrBy(STATS,"direct_directory_size_hit",1);
        console.log(JSON.stringify({event:"law_direct_directory_size_hit",key,name,count,source,website:website||""}));
        return {count,source,website};
      }
    }catch{}
  }
  await redis.hIncrBy(STATS,"direct_directory_size_miss",1);
  return {count:0,source:"",website:""};
}

async function directLawyerComSizeEvidence(lead={},key=""){
  const urls=lawyerComCandidateFirmUrls(lead);
  if(!urls.length)return {count:0,source:""};
  await redis.hIncrBy(STATS,"direct_lawyercom_size_attempt",1);
  const pages=await Promise.allSettled(urls.map(url=>fetchText(url,5500)));
  for(let i=0;i<pages.length;i++){
    if(pages[i].status!=="fulfilled"||!pages[i].value?.html)continue;
    const page=pages[i].value;
    const source=String(page.final_url||urls[i]);
    if(!/(^|\.)lawyer\.com$/i.test(hostOf(source)))continue;
    const text=stripHtml(page.html).slice(0,36000);
    if(!pageMatchesLead(text,lead,source))continue;
    const count=attorneyEstimate(page.html,text);
    if(count>0){
      await redis.hIncrBy(STATS,"direct_lawyercom_size_hit",1);
      console.log(JSON.stringify({event:"law_direct_lawyercom_size_hit",key,name:String(lead.name||lead.title||""),count,source}));
      return {count,source};
    }
  }
  await redis.hIncrBy(STATS,"direct_lawyercom_size_miss",1);
  return {count:0,source:""};
}

function decodeBingRedirect(raw=""){
  try{
    const url=new URL(String(raw||"").replace(/&amp;/g,"&"),"https://www.bing.com");
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
  let relativeRecovered=0;
  for(const m of String(html).matchAll(/href=["']([^"'#]+)["']/gi)){
    const raw=String(m[1]||"").replace(/&amp;/g,"&");
    if(!raw||/^(?:javascript:|mailto:|tel:)/i.test(raw))continue;
    const wasRelative=!/^https?:\/\//i.test(raw);
    const decoded=decodeBingRedirect(raw);
    if(!decoded)continue;
    try{
      const u=new URL(decoded);
      if(/(^|\.)bing\.com$/i.test(u.hostname))continue;
      if(!/^https?:$/.test(u.protocol))continue;
      out.push(u.href);
      if(wasRelative)relativeRecovered++;
    }catch{}
  }
  if(relativeRecovered)void redis.hIncrBy(STATS,"bing_relative_result_links",relativeRecovered).catch(()=>{});
  return [...new Set(out)].slice(0,16);
}
function bingRssResultLinks(xml=""){
  const out=[];
  for(const m of String(xml||"").matchAll(/<item>[\s\S]*?<link>(https?:\/\/[^<]+)<\/link>[\s\S]*?<\/item>/gi)){
    try{
      const u=new URL(String(m[1]||"").replace(/&amp;/g,"&"));
      if(/(^|\.)bing\.com$/i.test(u.hostname))continue;
      out.push(u.href);
    }catch{}
  }
  return [...new Set(out)].slice(0,12);
}
function yahooResultLinks(html=""){
  const out=[];
  for(const m of String(html||"").matchAll(/href=["']([^"']+)["']/gi)){
    const raw=String(m[1]||"").replace(/&amp;/g,"&");
    if(!raw||/^(?:javascript:|mailto:|tel:|#)/i.test(raw))continue;
    try{
      const u=new URL(raw,"https://search.yahoo.com");
      const host=u.hostname.toLowerCase();
      if(/(^|\.)yahoo\.com$/.test(host)||/(^|\.)search\.yahoo\.com$/.test(host))continue;
      if(!/^https?:$/.test(u.protocol))continue;
      out.push(u.href);
    }catch{}
  }
  return [...new Set(out)].slice(0,12);
}
async function findOwnedWebsitePreflight(lead,key="",force=false){
  if((!force&&!highValueLawResearchLead(lead))||lead.conversion_headcount_priority===true)return "";
  const name=String(lead.name||lead.title||"").replace(/"/g,"").trim();
  if(!name)return "";
  const phone=String(lead.phone||"").replace(/\D+/g,"").slice(-10);
  const city=normalizedLeadCity(lead);
  const region=normalizedStateCode(lead)||String(lead.region||lead.state||lead.state_code||lead.acquisition_location||"").trim();
  const queries=[...new Set([
    ...(phone?[`"${name}" "${phone}"`]:[]),
    `"${name}" ${city} ${region} website`.trim()
  ].filter(Boolean))].slice(0,2);
  const searchResults=await Promise.allSettled(queries.map(async q=>{
    const url="https://www.bing.com/search?q="+encodeURIComponent(q);
    const [htmlResult,rssResult]=await Promise.allSettled([
      fetchText(url,4200),
      fetchText("https://www.bing.com/search?format=rss&q="+encodeURIComponent(q),4200)
    ]);
    const html=htmlResult.status==="fulfilled"?htmlResult.value?.html||"":"";
    const rss=rssResult.status==="fulfilled"?rssResult.value?.html||"":"";
    return [...new Set([...bingResultLinks(html),...bingRssResultLinks(rss)])];
  }));
  const links=[];
  for(const result of searchResults){
    if(result.status!=="fulfilled")continue;
    for(const url of result.value||[]){
      // Exact-name/phone search results can reveal an owned site whose domain
      // is a brand alias unrelated to the firm's Maps name (for example an
      // initials/advocates domain). Fetch unknown first-party candidates and
      // let ownedWebsiteFromMatchedPage enforce exact identity/phone evidence.
      if(lawSourceRank(url,lead)!==6)continue;
      if(!links.includes(url))links.push(url);
      if(links.length>=8)break;
    }
  }
  const pages=await Promise.allSettled(links.slice(0,6).map(async url=>{
    try{return {url,page:await fetchText(url,3500)};}catch{return {url,page:null};}
  }));
  for(const item of pages){
    if(item.status!=="fulfilled"||!item.value?.page?.html)continue;
    const {url,page}=item.value;
    const pageText=stripHtml(page.html).slice(0,26000);
    const owned=ownedWebsiteFromMatchedPage(page.final_url||url,pageText,lead);
    if(owned){
      await redis.hIncrBy(STATS,"website_preflight_hit",1);
      return owned;
    }
  }
  await redis.hIncrBy(STATS,"website_preflight_miss",1);
  return "";
}
async function bingFallback(lead,query,pageBudget=6,key="",wantedEmails=[],deepPageBudget=2,seedLinks=[]){
  const emails=[],texts=[],sources=[],emailSources={};
  let attorneyCount=0,attorneyCountSource="",personalFact="",personalFactSource="",ownedWebsite="";
  // Keep enough email-specific searches to run; the previous six-query cap silently dropped later contact queries.
  const queries=[...new Set((Array.isArray(query)?query:[query]).map(x=>String(x||"").trim()).filter(Boolean))].slice(0,18);
  try{
    const searchResults=await Promise.allSettled(queries.map(async (q,searchIndex)=>{
      const url="https://www.bing.com/search?q="+encodeURIComponent(q);
      let result=null;
      try{result=await fetchText(url,5000);}catch{}
      let resultLinks=result?.html?bingResultLinks(result.html):[];
      // Bing HTML changes often. If normal link extraction is empty, use its
      // RSS result surface before paying for browser stealth.
      if(!resultLinks.length){
        try{
          const rssUrl="https://www.bing.com/search?format=rss&q="+encodeURIComponent(q);
          const rss=await fetchText(rssUrl,5000);
          resultLinks=bingRssResultLinks(rss?.html||"");
          if(resultLinks.length)await redis.hIncrBy(STATS,"bing_rss_query_hit",1);
        }catch{}
      }
      const expectedBar=expectedBarHost(lead);
      const targetsExpectedBar=Boolean(expectedBar&&String(q).toLowerCase().includes("site:"+expectedBar));
      if(expectedBar){
        const directState=String(lead.state_code||lead.region||lead.state||"").trim();
        const derivedState=normalizedStateCode(lead);
        if(directState)await redis.hIncrBy(STATS,"expected_bar_state_direct",1);
        else if(derivedState)await redis.hIncrBy(STATS,"expected_bar_state_derived",1);
      }
      if(expectedBar)await redis.hIncrBy(STATS,"expected_bar_eligible_query_checks",1);
      if(targetsExpectedBar)await redis.hIncrBy(STATS,"expected_bar_query_executed",1);
      const hasExpectedBarLink=resultLinks.some(u=>lawSourceRank(u,lead)===0);
      if(targetsExpectedBar&&!hasExpectedBarLink&&normalizedStateCode(lead)!=="CA"){
        try{
          const yahooUrl="https://search.yahoo.com/search?p="+encodeURIComponent(q);
          const yahoo=await fetchText(yahooUrl,7000);
          const yahooLinks=yahooResultLinks(yahoo?.html||"");
          const expectedYahoo=yahooLinks.filter(u=>lawSourceRank(u,lead)===0);
          if(expectedYahoo.length){
            resultLinks=[...new Set([...expectedYahoo,...resultLinks])];
            await redis.hIncrBy(STATS,"yahoo_expected_bar_query_hit",1);
            await redis.hIncrBy(STATS,"yahoo_expected_bar_result_links",expectedYahoo.length);
          }else{
            await redis.hIncrBy(STATS,"yahoo_expected_bar_query_miss",1);
          }
        }catch{
          await redis.hIncrBy(STATS,"yahoo_expected_bar_fetch_error",1);
        }
      }
      if(!resultLinks.length&&searchIndex<3){
        const stealth=await callScrapling(url,{allowBrowser:lead.conversion_headcount_priority===true});
        if(stealth?.html){
          result=stealth;
          resultLinks=[...new Set([...bingResultLinks(stealth.html),...markdownResultLinks(stealth.html)])];
          if(resultLinks.length)await redis.hIncrBy(STATS,"scrapling_search_hit",1);
        }
      }
      return {q,url,...(result||{html:"",final_url:url,status:0}),resultLinks};
    }));
    // Guarantee source diversity: bar/court/government and PDFs get reserved
    // slots before directories or generic results can consume the page budget.
    const authoritative=[],legalRecords=[],pdfs=[],directories=[],other=[];
    for(const link of (seedLinks||[])){
      if(!authoritative.includes(link))authoritative.push(link);
    }
    for(const item of searchResults){
      if(item.status!=="fulfilled"){
        await redis.hIncrBy(STATS,"bing_query_fetch_reject",1);
        continue;
      }
      const result=item.value;
      const expectedBar=expectedBarHost(lead);
      const queryTargetsExpectedBar=Boolean(expectedBar&&String(result.q||"").toLowerCase().includes("site:"+expectedBar));
      const searchText=stripHtml(result.html).slice(0,10000);
      texts.push(searchText);
      const legalIntent=/notice to creditors|attorney for|represented by|bankruptcy|legal notice|email court|email bar|filetype:pdf/i.test(String(result.q||""));
      const ranked=(result.resultLinks||bingResultLinks(result.html))
        .filter(u=>{
          const rank=lawSourceRank(u,lead);
          if(rank>=90)return false;
          if(rank===0)return true;
          if(rank<=4&&legalRecordUrlLikely(u))return true;
          if(/\.pdf(?:$|[?#])/i.test(u)&&legalRecordUrlLikely(u))return true;
          if(legalIntent&&legalRecordUrlLikely(u))return true;
          // Generic web results are only worth crawling when the domain itself
          // resembles the target firm. Legal-intent queries no longer exempt
          // arbitrary web results such as History.com, Forbes, or baby-name sites.
          const keep=ownedDomainAffinity(u,lead);
          if(!keep){
            void redis.hIncrBy(STATS,"bing_generic_link_reject",1).catch(()=>{});
            if(rank<=4)void redis.hIncrBy(STATS,"bing_trusted_link_reject",1).catch(()=>{});
          }
          return keep;
        })
        .sort((a,b)=>lawSourceRank(a,lead)-lawSourceRank(b,lead));
      if(ranked.some(u=>lawSourceRank(u,lead)<=1))await redis.hIncrBy(STATS,"bar_query_hit",1);
      if(queryTargetsExpectedBar&&ranked.length){
        await redis.hIncrBy(STATS,"expected_bar_query_with_links",1);
        const expectedLinks=ranked.filter(u=>lawSourceRank(u,lead)===0).length;
        if(expectedLinks)await redis.hIncrBy(STATS,"expected_bar_result_links",expectedLinks);
      }
      if(ranked.length)await redis.hIncrBy(STATS,"bing_queries_with_links",1);
      for(const link of ranked){
        const rank=lawSourceRank(link,lead);
        const bucket=rank<=2?authoritative:
          /\.pdf(?:$|[?#])/i.test(link)?pdfs:
          legalIntent?legalRecords:
          rank<=4?directories:other;
        if(!bucket.includes(link))bucket.push(link);
      }
    }
    const links=[];
    const take=(bucket,count)=>{
      for(const link of bucket){
        if(links.length>=pageBudget||count<=0)break;
        if(!links.includes(link)){links.push(link);count--;}
      }
    };
    const directSeedCount=Math.min(pageBudget,(seedLinks||[]).length);
    if(directSeedCount)take(authoritative,directSeedCount);
    take(authoritative,Math.max(0,Math.ceil(pageBudget*0.3)-directSeedCount));
    take(legalRecords,Math.max(1,Math.ceil(pageBudget*0.3)));
    take(pdfs,Math.max(1,Math.ceil(pageBudget*0.2)));
    take(directories,Math.max(1,Math.ceil(pageBudget*0.1)));
    take([...authoritative,...legalRecords,...pdfs,...directories,...other],pageBudget-links.length);
    // Fetch actual source pages for corroboration. Search-result snippets are
    // never treated as publish-source evidence.
    if(links.length)await redis.hIncrBy(STATS,"bing_source_links",links.length);
    const pages=await Promise.allSettled(links.slice(0,pageBudget).map((target,pageIndex)=>{
      const forceOfficialDeep=isDirectCalBarProfile(target);
      return fetchResearchPage(target,lead,key,forceOfficialDeep||pageIndex<deepPageBudget);
    }));
    for(let i=0;i<pages.length;i++){
      const item=pages[i];
      if(item.status!=="fulfilled"){
        await redis.hIncrBy(STATS,"bing_source_page_fetch_reject",1);
        continue;
      }
      const page=item.value,target=links[i];
      if(!page?.html)continue;
      const pageText=stripHtml(page.html).slice(0,22000);
      if(!pageMatchesLead(pageText,lead,page.final_url||target))continue;
      const matchedRank=lawSourceRank(page.final_url||target,lead);
      if(isDirectCalBarProfile(page.final_url||target)){
        const barWebsite=calBarPublishedWebsite(page.html);
        if(barWebsite&&!ownedWebsite){
          ownedWebsite=barWebsite;
          await redis.hIncrBy(STATS,"calbar_profile_website_hit",1);
        }
      }
      if(matchedRank<=1)await redis.hIncrBy(STATS,"bar_source_page_matched",1);
      if(matchedRank===0)await redis.hIncrBy(STATS,"expected_bar_page_matched",1);
      if(/apps\.calbar\.ca\.gov\/attorney\/Licensee\/Detail\//i.test(String(page.final_url||target)))await redis.hIncrBy(STATS,"direct_calbar_page_matched",1);
      if(!ownedWebsite)ownedWebsite=ownedWebsiteFromMatchedPage(page.final_url||target,pageText,lead);
      const rawPageEmails=emailsFrom(page.html).filter(x=>!isThirdPartyEmailDomain(x));
      if(rawPageEmails.length)await redis.hIncrBy(STATS,"bing_source_raw_email_pages",1);
      const discoveredEmails=contextualEmails(page.html,lead,page.final_url||target);
      if(rawPageEmails.length&&!discoveredEmails.length){
        await redis.hIncrBy(STATS,"bing_source_context_reject_email_pages",1);
        console.log(JSON.stringify({
          event:"law_email_context_reject_page",
          key,
          name:String(lead.name||lead.title||""),
          source:String(page.final_url||target),
          rawEmails:rawPageEmails.slice(0,4),
          sourceRank:lawSourceRank(page.final_url||target,lead)
        }));
      }
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
        const evidenceSource=page.final_url||target;
        sources.unshift(evidenceSource);
        for(const email of pageEmails){
          if(!emailSources[String(email).toLowerCase()])emailSources[String(email).toLowerCase()]=evidenceSource;
        }
        await redis.hIncrBy(STATS,"bing_source_email_pages",1);
        const evidenceRank=lawSourceRank(evidenceSource,lead);
        if(evidenceRank<=1)await redis.hIncrBy(STATS,"bar_email_page",1);
        if(evidenceRank===0)await redis.hIncrBy(STATS,"expected_bar_email_page",1);
        if(/apps\.calbar\.ca\.gov\/attorney\/Licensee\/Detail\//i.test(String(evidenceSource)))await redis.hIncrBy(STATS,"direct_calbar_email_page",1);
      }
    }
  }catch(error){
    await redis.hIncrBy(STATS,"bing_fallback_error",1);
    console.warn(JSON.stringify({event:"law_bing_fallback_error",key,error:String(error?.message||error).slice(0,240)}));
  }
  return {emails:[...new Set(emails)],emailSources,text:texts.join(" ").slice(0,24000),source:sources[0]||"",attorneyCount,attorneyCountSource,personalFact,personalFactSource,ownedWebsite};
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
    `"${firmName}" site:lawyers.com "Lawyers:"`,
    `"${firmName}" site:findlaw.com attorneys`,
    `"${firmName}" site:justia.com attorneys`
  ]:[];
  const existingEmails=[...(Array.isArray(lead.emails)?lead.emails:[]),lead.email]
    .filter(x=>isUsableLawEmail(x)&&!isThirdPartyEmailDomain(x));
  const shape=lawFirmNameShape(lead);
  // Email is the first money gate. Firm-shaped names used to prioritize size
  // before contact discovery, starving the first search waves of email queries.
  // Only switch to size-first after an email exists or in the dedicated
  // post-email headcount conversion pass.
  const chicagoWebsiteBuild=/\bchicago\b/i.test(String(lead.acquisition_location||lead.target_area||"")) &&
    !String(lead.website||"").trim() &&
    (shape==="multi"||shape==="firm");
  const prioritizeSize=existingEmails.length>0||lead.conversion_headcount_priority===true||chicagoWebsiteBuild;
  const queries=[...new Set(prioritizeSize
    ? [...headcountQueries,...attorneyQueries.slice(0,2),...baseQueries,...attorneyQueries.slice(2)]
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
  const emails=[...existingEmails],texts=[],sources=[],emailSources={};
  const existingEvidenceSource=String(lead.law_email_source||lead.email_source||lead.personalization_source||"");
  for(const email of existingEmails){if(existingEvidenceSource)emailSources[String(email).toLowerCase()]=existingEvidenceSource;}
  let attorneyCount=existingAttorneyCount,attorneyCountSource=String(lead.attorney_count_source||""),personalFact="",personalFactSource="",ownedWebsite="";
  const visited=new Set();

  const absorbPage=(html="",finalUrl="")=>{
    const pageText=stripHtml(html).slice(0,22000);
    if(!pageMatchesLead(pageText,lead,finalUrl))return;
    if(!ownedWebsite)ownedWebsite=ownedWebsiteFromMatchedPage(finalUrl,pageText,lead);
    const rawPageEmails=emailsFrom(html).filter(x=>!isThirdPartyEmailDomain(x));
    if(rawPageEmails.length)void redis.hIncrBy(STATS,"duck_source_raw_email_pages",1);
    const pageEmails=contextualEmails(html,lead,finalUrl);
    if(rawPageEmails.length&&!pageEmails.length){
      void redis.hIncrBy(STATS,"duck_source_context_reject_email_pages",1);
      console.log(JSON.stringify({event:"law_email_context_reject_page",key,name:String(lead.name||lead.title||""),source:String(finalUrl||""),rawEmails:rawPageEmails.slice(0,4),sourceRank:lawSourceRank(finalUrl,lead),engine:"duck"}));
    }
    if(pageEmails.length){
      emails.push(...pageEmails);
      if(finalUrl&&!sources.includes(finalUrl))sources.unshift(finalUrl);
      for(const email of pageEmails){
        if(finalUrl&&!emailSources[String(email).toLowerCase()])emailSources[String(email).toLowerCase()]=finalUrl;
      }
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
      if(emails.length&&attorneyCount>=2&&attorneyCount<=10)return {emails:rankLawEmails(emails),emailSources,text:texts.join(" ").slice(0,48000),source:sources[0]||"",attorneyCount,attorneyCountSource,personalFact,personalFactSource};
    }catch{}
  }

  // Three bounded search waves. Email-first prospects get enough room to reach
  // public-record/contact queries; post-email conversion prospects stay size-first.
  const waves=(lead.conversion_headcount_priority===true||chicagoWebsiteBuild)
    ? [queries.slice(0,4),queries.slice(4,8),queries.slice(8,12)]
    : [queries.slice(0,4)];
  for(const wave of waves){
    if(!wave.length||(emails.length&&attorneyCount>=2&&attorneyCount<=10))break;
    const searchResults=await Promise.allSettled(wave.map(async (q,searchIndex)=>{
      const url="https://html.duckduckgo.com/html/?q="+encodeURIComponent(q);
      let result=null;
      try{result=await fetchText(url,4500);}catch{}
      let resultLinks=result?.html?duckResultLinks(result.html):[];
      if(!resultLinks.length&&searchIndex===0&&lead.conversion_headcount_priority===true){
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

    const deepPageLimit=(lead.conversion_headcount_priority===true||chicagoWebsiteBuild)?3:0;
    const pages=await Promise.allSettled(pageCandidates.slice(0,3).map((target,pageIndex)=>fetchResearchPage(target,lead,key,pageIndex<deepPageLimit)));
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
    emailSources,
    text:combined.slice(0,48000),
    source:sources[0]||"",
    attorneyCount,
    attorneyCountSource,
    personalFact,
    personalFactSource,
    ownedWebsite
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
const US_STATE_CODE_BY_NAME={
  ALABAMA:"AL",ALASKA:"AK",ARIZONA:"AZ",ARKANSAS:"AR",CALIFORNIA:"CA",COLORADO:"CO",
  CONNECTICUT:"CT",DELAWARE:"DE",FLORIDA:"FL",GEORGIA:"GA",HAWAII:"HI",IDAHO:"ID",
  ILLINOIS:"IL",INDIANA:"IN",IOWA:"IA",KANSAS:"KS",KENTUCKY:"KY",LOUISIANA:"LA",
  MAINE:"ME",MARYLAND:"MD",MASSACHUSETTS:"MA",MICHIGAN:"MI",MINNESOTA:"MN",
  MISSISSIPPI:"MS",MISSOURI:"MO",MONTANA:"MT",NEBRASKA:"NE",NEVADA:"NV",
  "NEW HAMPSHIRE":"NH","NEW JERSEY":"NJ","NEW MEXICO":"NM","NEW YORK":"NY",
  "NORTH CAROLINA":"NC","NORTH DAKOTA":"ND",OHIO:"OH",OKLAHOMA:"OK",OREGON:"OR",
  PENNSYLVANIA:"PA","RHODE ISLAND":"RI","SOUTH CAROLINA":"SC","SOUTH DAKOTA":"SD",
  TENNESSEE:"TN",TEXAS:"TX",UTAH:"UT",VERMONT:"VT",VIRGINIA:"VA",WASHINGTON:"WA",
  "WEST VIRGINIA":"WV",WISCONSIN:"WI",WYOMING:"WY","DISTRICT OF COLUMBIA":"DC"
};
function normalizedStateCode(lead={}){
  const direct=String(lead.state_code||lead.region||lead.state||"").trim().toUpperCase().replace(/\s+/g," ");
  if(/^[A-Z]{2}$/.test(direct))return direct;
  if(US_STATE_CODE_BY_NAME[direct])return US_STATE_CODE_BY_NAME[direct];

  // Older Maps/acquisition records often carry geography only inside address,
  // acquisition_location or target_area (e.g. "Houston, TX" / "Texas").
  const raw=[lead.address,lead.acquisition_location,lead.target_area,lead.formatted_address]
    .map(x=>String(x||"").trim()).filter(Boolean).join(" | ").toUpperCase();

  const codeMatch=raw.match(/(?:,|\b)\s*(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)(?:\s+\d{5}(?:-\d{4})?)?\b/);
  if(codeMatch)return codeMatch[1];

  for(const [name,code] of Object.entries(US_STATE_CODE_BY_NAME)){
    if(raw.includes(name))return code;
  }
  return "";
}
function normalizedLeadCity(lead={}){
  const direct=String(lead.city||lead.locality||"").trim();
  if(direct)return direct;
  const raw=String(lead.address||lead.acquisition_location||lead.target_area||lead.formatted_address||"").trim();
  const m=raw.match(/(?:^|,\s*)([^,|]+),\s*(?:[A-Z]{2}|[A-Za-z ]+)(?:\s+\d{5}(?:-\d{4})?)?\s*(?:\||$)/);
  return m?String(m[1]||"").trim():"";
}
const STATE_BAR_DOMAINS={
  TX:"texasbar.com",FL:"floridabar.org/directories/find-mbr",CA:"apps.calbar.ca.gov/attorney",NY:"nycourts.gov",
  NJ:"njcourts.gov",PA:"pabar.org",IL:"iardc.org",OH:"supremecourt.ohio.gov",
  GA:"gabar.org",NC:"ncbar.gov",SC:"scbar.org",VA:"vsb.org",WA:"wsba.org",
  OR:"osbar.org",AZ:"azbar.org",CO:"coloradosupremecourt.com",MI:"michbar.org",
  MN:"mnbars.org",MO:"mobar.org",TN:"tbpr.org",MA:"massbbo.org",MD:"mdcourts.gov",
  AK:"member.alaskabar.org",AL:"members.alabar.org",MS:"msbar.org",KY:"kybar.org",
  LA:"lsba.org",OK:"ams.okbar.org"
};
function stateBarDomain(lead={}){
  const state=normalizedStateCode(lead);
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
  if(/govinfo\.gov|docs\.justia\.com|floridapublicnotices\.com|publicnotices|docketalarm\.com|trellis\.law/i.test(host))return 2;
  if(/justia\.com|lawyers\.com|martindale\.com|findlaw\.com|avvo\.com|superlawyers\.com|attorneydir\.com|lawyer-map\.com/i.test(host))return 3;
  if(/allbiz\.com|chamberofcommerce\.com|manta\.com|bbb\.org/i.test(host))return 4;
  if(/facebook\.com|linkedin\.com|instagram\.com|tiktok\.com|youtube\.com|x\.com|twitter\.com|pinterest\.com|mapquest\.com/i.test(host))return 90;
  return 6;
}
function legalRecordUrlLikely(url=""){
  let u;try{u=new URL(String(url||""));}catch{return false;}
  const host=u.hostname.toLowerCase().replace(/^www\./,"");
  const path=(u.pathname+" "+u.search).toLowerCase();
  if(/(?:court|courts|uscourts|judicial|judiciary|bar|disciplin|attorney|lawyer|legal|bankrupt|docket|case|publicnotice|public-notice|notice)/i.test(host))return true;
  if(/\/(?:attorney|lawyer|legal|court|case|docket|bankrupt|notice|public[-_]?notice|creditor|disciplin)/i.test(path))return true;
  if(/floridapublicnotices\.com|govinfo\.gov|docs\.justia\.com|docketalarm\.com|trellis\.law|attorneydir\.com|lawyer-map\.com/i.test(host))return true;
  return false;
}

function emailRecoveryPriority(lead={}){
  let score=0;
  const shape=lawFirmNameShape(lead);
  const verifiedCount=lead.attorney_count_evidence_verified===true?Number(lead.attorney_count_estimate||0):0;
  if(verifiedCount>=2&&verifiedCount<=10)score+=8;
  if(shape==="multi")score+=4;
  else if(shape==="firm")score+=3;
  else if(shape==="solo")score-=2;

  // Identity/contact completeness only breaks ties; it no longer makes a solo
  // office "priority" by itself.
  if(likelyAttorneyName(lead))score+=1;
  if(String(lead.phone||"").replace(/\D+/g,"").slice(-10).length===10)score+=1;
  if(stateBarDomain(lead))score+=1;
  if(normalizedLeadCity(lead))score+=1;
  return score;
}
function stateBarQueries(lead={},people=[]){
  const state=normalizedStateCode(lead);
  const name=String(lead.name||lead.title||"").replace(/"/g,"").trim();
  const phone=String(lead.phone||"").replace(/\D+/g,"").slice(-10);
  const person=people[0]||"";
  const alternate=people[1]||"";
  const out=[];
  if(state==="FL"){
    if(person)out.push(`site:floridabar.org/directories/find-mbr/profile "${person}"`);
    if(name)out.push(`site:floridabar.org/directories/find-mbr "${name}"`);
    if(phone)out.push(`site:floridabar.org/directories/find-mbr "${phone}"`);
    if(alternate)out.push(`site:floridabar.org/directories/find-mbr/profile "${alternate}"`);
  }else if(state==="CA"){
    if(person)out.push(`site:apps.calbar.ca.gov/attorney "${person}"`);
    if(name)out.push(`site:apps.calbar.ca.gov/attorney "${name}"`);
    if(phone)out.push(`site:apps.calbar.ca.gov/attorney "${phone}"`);
    if(alternate)out.push(`site:apps.calbar.ca.gov/attorney "${alternate}"`);
  }else if(state==="TX"){
    if(person)out.push(`site:texasbar.com "Find A Lawyer" "${person}"`);
    if(name)out.push(`site:texasbar.com "Find A Lawyer" "${name}"`);
    if(phone)out.push(`site:texasbar.com "Find A Lawyer" "${phone}"`);
    if(person)out.push(`"${person}" Texas attorney email filetype:pdf`);
  }else if(state==="NY"){
    if(person)out.push(`site:nycourts.gov "${person}" attorney`);
    if(name)out.push(`site:nycourts.gov "${name}" attorney`);
    if(phone)out.push(`site:nycourts.gov "${phone}" attorney`);
  }else{
    const domain=stateBarDomain(lead);
    if(domain&&person)out.push(`site:${domain} "${person}" attorney`);
    if(domain&&name)out.push(`site:${domain} "${name}"`);
    if(domain&&phone)out.push(`site:${domain} "${phone}"`);
  }
  if(person){
    out.push(`"${person}" "${state}" attorney email court`);
    out.push(`"${person}" "${state}" attorney email bar`);
    out.push(`"${person}" "${state}" attorney email filetype:pdf`);
  }
  if(name){
    out.push(`"${name}" "${state}" email court`);
    out.push(`"${name}" "${state}" email filetype:pdf`);
  }
  return [...new Set(out)].slice(0,8);
}


const DIRECT_CALBAR_UNIQUE_PROFILE_URLS=new Set();
const DIRECT_CALBAR_ACTIVE_PROFILE_URLS=new Set();
function boundedAdd(set,value,max=2000){
  const normalized=String(value||"").split("#")[0];
  if(!normalized)return;
  set.add(normalized);
  while(set.size>max){
    const first=set.values().next().value;
    if(first)set.delete(first); else break;
  }
}
function markUniqueCalBarProfile(url=""){boundedAdd(DIRECT_CALBAR_UNIQUE_PROFILE_URLS,url,1500);}
function isUniqueCalBarProfile(url=""){
  return DIRECT_CALBAR_UNIQUE_PROFILE_URLS.has(String(url||"").split("#")[0]);
}
function markActiveCalBarProfile(url=""){boundedAdd(DIRECT_CALBAR_ACTIVE_PROFILE_URLS,url,2500);}
function isActiveCalBarProfile(url=""){
  return DIRECT_CALBAR_ACTIVE_PROFILE_URLS.has(String(url||"").split("#")[0]);
}

function calBarSearchRowName(context=""){
  const plain=String(context||"").replace(/\s+/g," ").trim();
  // QuickSearch rows render as "Last, First Middle Active 123456 City ...".
  const m=plain.match(/([A-Z][A-Za-z.'’\- ]{1,80},\s*[A-Z][A-Za-z.'’\- ]{1,80})\s+(?:Active|Inactive|Disbarred|Resigned|Deceased|Suspended)\b/i);
  return m?.[1]?String(m[1]).trim():"";
}
function normalizedPersonParts(name=""){
  const suffix=/^(?:jr|sr|ii|iii|iv|esq)$/i;
  return normalize(String(name||"").replace(/,/g," "))
    .split(" ").map(x=>x.replace(/[^a-z]/g,"")).filter(x=>x&&!suffix.test(x));
}
function calBarPublishedNameMatchesLead(publishedName="",lead={}){
  const pubRaw=String(publishedName||"").trim();
  if(!pubRaw)return false;
  const comma=pubRaw.includes(",");
  let pub=normalizedPersonParts(pubRaw);
  if(comma&&pub.length>=2)pub=[...pub.slice(1),pub[0]]; // Last, First Middle -> First Middle Last
  if(pub.length<2)return false;
  const pubFirst=pub[0],pubLast=pub[pub.length-1],pubMiddle=pub.slice(1,-1);

  for(const variant of attorneyNameVariants(lead)){
    const v=normalizedPersonParts(variant);
    if(v.length<2)continue;
    const first=v[0],last=v[v.length-1],middle=v.slice(1,-1);
    if(first!==pubFirst||last!==pubLast)continue;
    // Middle initials/full names may differ in length, but when both sides have
    // substantive middle information it must be compatible.
    const leadMid=middle.find(x=>x.length>=1)||"";
    const pubMid=pubMiddle.find(x=>x.length>=1)||"";
    if(leadMid&&pubMid&&leadMid[0]!==pubMid[0])continue;
    return true;
  }
  return false;
}

async function directOfficialProfileLinks(lead={},people=[]){
  const state=normalizedStateCode(lead);
  if(state==="AK"){
    return ["https://member.alaskabar.org/cv5/cgi-bin/utilities.dll/customlist?ADDRESSTYPE=Work&CUSTOMERCD=&SQLNAME=GETMEMDIRADDR&wbp=Customer_Address.htm&whp=none&wmt=none&wnr=Customer_Address_None.htm"];
  }
  if(state==="FL"){
    const profiles=[];
    const names=[...new Set((people||[]).filter(Boolean).slice(0,3))];
    for(const person of names){
      const parts=normalizedPersonParts(person);
      if(parts.length<2)continue;
      const first=parts[0],last=parts[parts.length-1];
      try{
        await redis.hIncrBy(STATS,"direct_floridabar_search_attempt",1);
        const searchUrl="https://www.floridabar.org/directories/find-mbr/?lName="+encodeURIComponent(last)+"&fName="+encodeURIComponent(first)+"&sdx=N&eligible=N&deceased=N&pageNumber=1&pageSize=10";
        const page=await fetchText(searchUrl,7000);
        const html=String(page?.html||"");
        for(const m of html.matchAll(/href=["']([^"']*\/directories\/find-mbr\/profile\/\?[^"']*num=\d+[^"']*)["']/gi)){
          try{
            const href=new URL(String(m[1]||""),searchUrl).href.split("#")[0];
            if(!profiles.includes(href))profiles.push(href);
          }catch{}
        }
        if(profiles.length){
          await redis.hIncrBy(STATS,"direct_floridabar_profile_links",profiles.length);
          break;
        }
      }catch{
        await redis.hIncrBy(STATS,"direct_floridabar_search_error",1);
      }
    }
    return profiles.slice(0,8);
  }
  // Five high-volume state adapters. Each does one narrow lookup against the
  // official directory domain before the broad web-search waterfall.
  const officialHosts={
    TX:"texasbar.com",
    IL:"iardc.org",
    GA:"gabar.org",
    NC:"portal.ncbar.gov",
    WA:"wsba.org"
  };
  if(officialHosts[state]){
    const host=officialHosts[state];
    const out=[];
    const names=[...new Set((people||[]).filter(Boolean).slice(0,2))];
    const firm=String(lead.name||lead.title||"").replace(/["']/g," ").replace(/\s+/g," ").trim();
    if(state==="GA"){
      for(const person of names){
        const parts=normalizedPersonParts(person);
        if(parts.length<2)continue;
        const first=parts[0],last=parts[parts.length-1];
        try{
          await redis.hIncrBy(STATS,"direct_gabar_search_attempt",1);
          const directUrl="https://www.gabar.org/member-directory/?firstName="+encodeURIComponent(first)+"&lastName="+encodeURIComponent(last);
          const page=await fetchText(directUrl,6000);
          const html=String(page?.html||"");
          const candidates=[...new Set(Array.from(html.matchAll(/href=["\']([^"\']*(?:member-directory|profile)[^"\']*)["\']/gi)).map(m=>{
            try{return new URL(String(m[1]||""),directUrl).href;}catch{return "";}
          }).filter(Boolean))].filter(u=>{
            const h=hostOf(u);
            return h&&(h==="gabar.org"||h.endsWith(".gabar.org"));
          }).slice(0,8);
          if(candidates.length){
            out.push(...candidates);
            await redis.hIncrBy(STATS,"direct_gabar_profile_links",candidates.length);
            return [...new Set(out)].slice(0,8);
          }
        }catch{
          await redis.hIncrBy(STATS,"direct_gabar_search_error",1);
        }
      }
    }
    const queries=[...names.map(n=>"site:"+host+" \""+n+"\""),...(firm?["site:"+host+" \""+firm+"\""]:[])].slice(0,2);
    for(const q of queries){
      try{
        await redis.hIncrBy(STATS,"direct_"+state.toLowerCase()+"bar_search_attempt",1);
        const page=await fetchText("https://www.bing.com/search?q="+encodeURIComponent(q),5000);
        const links=[...new Set(bingResultLinks(String(page?.html||"")))]
          .filter(u=>{
            const h=hostOf(u);
            if(!h||!(h===host||h.endsWith("."+host)))return false;
            if(state==="TX")return /Template\.cfm\?[^#]*ContactID=\d+/i.test(u);
            if(state==="IL")return /lawyer/i.test(u);
            if(state==="GA")return /member-directory|member|profile/i.test(u);
            if(state==="NC")return /verification|member|search/i.test(u);
            if(state==="WA")return /legal-directory|lawyer|member|profile|search/i.test(u);
            return true;
          })
          .sort((a,b)=>lawSourceRank(a,lead)-lawSourceRank(b,lead))
          .slice(0,6);
        if(links.length){
          out.push(...links);
          await redis.hIncrBy(STATS,"direct_"+state.toLowerCase()+"bar_profile_links",links.length);
          break;
        }
      }catch{
        await redis.hIncrBy(STATS,"direct_"+state.toLowerCase()+"bar_search_error",1);
      }
    }
    if(out.length)return [...new Set(out)].slice(0,8);
  }

  if(state!=="CA")return [];
  const queries=[...new Set([
    ...(people||[]).filter(Boolean).slice(0,2),
    String(lead.name||lead.title||"").replace(/\b(law offices?|law office|law firm|attorneys? at law|attorney at law|pc|p\.c\.|pllc|llc|llp|apc|esq\.?|esquire)\b/gi," ").replace(/\s+/g," ").trim()
  ].filter(x=>String(x||"").trim().length>=4))].slice(0,2);

  const out=[];
  for(const q of queries){
    try{
      await redis.hIncrBy(STATS,"direct_calbar_search_attempt",1);
      const url="https://apps.calbar.ca.gov/attorney/LicenseeSearch/QuickSearch?FreeText="+encodeURIComponent(q);
      const page=await fetchText(url,7000);
      const html=String(page?.html||"");
      if(!html)continue;
      const links=[];
      const queryLooksPerson=(people||[]).some(p=>normalize(p)===normalize(q));
      for(const m of html.matchAll(/href=["']([^"']*\/attorney\/Licensee\/Detail\/\d+[^"']*)["']/gi)){
        try{
          const u=new URL(String(m[1]||""),url);
          const href=u.href.split("#")[0];
          const idx=Number(m.index||0);
          const context=stripHtml(html.slice(Math.max(0,idx-1800),Math.min(html.length,idx+2400)));
          const publishedName=calBarSearchRowName(context);
          if(queryLooksPerson&&publishedName&&!calBarPublishedNameMatchesLead(publishedName,lead)){
            await redis.hIncrBy(STATS,"direct_calbar_search_identity_reject",1);
            continue;
          }
          links.push(href);
          const hasInactive=/\bInactive\b/i.test(context);
          const hasActive=/\bActive\b/i.test(context);
          if(hasActive&&!hasInactive){
            markActiveCalBarProfile(href);
            await redis.hIncrBy(STATS,"direct_calbar_active_from_search",1);
          }
        }catch{}
      }
      const unique=[...new Set(links)].slice(0,8);
      if(unique.length){
        await redis.hIncrBy(STATS,"direct_calbar_profile_links",unique.length);
        if(unique.length===1){
          markUniqueCalBarProfile(unique[0]);
          await redis.hIncrBy(STATS,"direct_calbar_unique_profile",1);
          // For a single deterministic result, the QuickSearch page's table-level
          // Active status is authoritative for that exact profile.
          const searchText=stripHtml(html);
          if(/\bActive\b/i.test(searchText)&&!/\bInactive\b/i.test(searchText)){
            markActiveCalBarProfile(unique[0]);
            await redis.hIncrBy(STATS,"direct_calbar_unique_active",1);
          }
        }
        out.push(...unique);
        break;
      }
    }catch{
      await redis.hIncrBy(STATS,"direct_calbar_search_error",1);
    }
  }
  return [...new Set(out)].slice(0,8);
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
  const enrichStartedAt=Date.now();
  if(String(lead.search_profile||"")!=="law-firm"&&normalize(lead.industry)!=="law firm")return false;
  if(!isLawFirmLead(lead)){
    await redis.sAdd(ENRICHED_SET,key);
    await redis.sAdd(REJECTED_SET,key);
    await Promise.all([redis.sRem(READY_SET,key),redis.sRem(EMAIL_CANDIDATE_SET,key)]);
    await redis.hIncrBy(STATS,"rejected_not_law_firm",1);
    return true;
  }
  if(await redis.sIsMember(ENRICHED_SET,key))return false;

  let website=String(lead.website||"").trim();
  const chicagoLead=/\bchicago\b/i.test(String(lead.acquisition_location||lead.target_area||""));
  const pipelineWebsiteEvidence=String(lead.owned_website_evidence_source||"").trim();
  if(chicagoLead&&/^https?:\/\//i.test(website)&&pipelineWebsiteEvidence){
    const verifiedWebsite=await verifyOwnedWebsiteCandidate(website,lead);
    if(verifiedWebsite){
      website=verifiedWebsite;
      if(website!==String(lead.website||"")){
        lead={...lead,website};
        await redis.hSet(LEAD_HASH,key,JSON.stringify(lead));
      }
    }else{
      // A directory/ad/alias false positive must not disqualify a no-website lead.
      website="";
      lead={...lead,website:"",owned_website_evidence_source:""};
      await redis.hSet(LEAD_HASH,key,JSON.stringify(lead));
      await redis.sRem(REJECTED_SET,key);
      await redis.sRem(ENRICHED_SET,key);
      await redis.hIncrBy(STATS,"chicago_false_website_cleared",1);
    }
  }
  const chicagoHeadcountCampaign=!website &&
    chicagoLead &&
    lawFirmNameShape(lead)!=="solo";
  if(/^https?:\/\//i.test(website)){
    await redis.sAdd(ENRICHED_SET,key);
    await redis.sAdd(REJECTED_SET,key);
    await Promise.all([redis.sRem(READY_SET,key),redis.sRem(EMAIL_CANDIDATE_SET,key),redis.sRem(CHICAGO_PENDING_SET,key)]);
    await redis.hIncrBy(STATS,"rejected_has_website",1);
    return true;
  }

  // Maps can omit a firm's real website. For the active Chicago website-build
  // campaign, verify the no-owned-website condition before spending headcount
  // research. This removes false positives such as firms whose site is absent
  // from the Maps row but discoverable by exact firm identity + phone.
  if(chicagoHeadcountCampaign){
    const discoveredSite=await findOwnedWebsitePreflight(lead,key,true);
    if(discoveredSite){
      const updated={...lead,website:discoveredSite,website_opportunity:"website_refresh",owned_website_evidence_source:"chicago_preflight"};
      await redis.hSet(LEAD_HASH,key,JSON.stringify(updated));
      await Promise.all([
        redis.sRem(READY_SET,key),
        redis.sRem(EMAIL_CANDIDATE_SET,key),
        redis.sRem(CHICAGO_PENDING_SET,key)
      ]);
      await redis.sAdd(REJECTED_SET,key);
      await redis.sAdd(ENRICHED_SET,key);
      await redis.hIncrBy(STATS,"website_preflight_hit",1);
      console.log(JSON.stringify({event:"law_firm_enriched",key,name:lead.name,emails:0,emailMethod:"none",attorneyCount:null,attorneyCountVerified:false,attorneyCountSource:"",effectiveWebsite:discoveredSite,sizeTier:"unknown",practice:"",painPoint:"Has website",qualified:false,rejectReason:"has_owned_website_chicago_preflight",priority:0,personalizationQuality:"basic",elapsedMs:Date.now()-enrichStartedAt}));
      return true;
    }
  }else{
    await redis.hIncrBy(STATS,"website_preflight_deferred",1);
  }

  const existingSource=String(lead.law_email_source||lead.email_source||lead.email_evidence_url||"").trim();
  const existingCandidates=[...(Array.isArray(lead.emails)?lead.emails:[]),lead.email]
    .map(x=>String(x||"").trim().toLowerCase())
    .filter(x=>isUsableLawEmail(x)&&!isThirdPartyEmailDomain(x));
  const existingSourceBacked=isDirectPublishedEmailSource(existingSource);
  let emails=existingSourceBacked?existingCandidates:[], combined="",source=existingSourceBacked?existingSource:"",attorneyCount=lead.attorney_count_evidence_verified===true?Number(lead.attorney_count_estimate||0):0;
  const emailEvidenceSources={};
  if(existingSourceBacked){for(const email of existingCandidates)emailEvidenceSources[email]=existingSource;}
  let attorneyCountVerified=lead.attorney_count_evidence_verified===true&&attorneyCount>0,attorneyCountSource=attorneyCountVerified?String(lead.attorney_count_source||""):"";
  let personalFact="",personalFactSource="";
  let emailMethod=emails.length?"existing_source_backed":"none";
  if(emailMethod!=="none")await redis.hIncrBy(STATS,"email_existing_hit",1);

  // Recover previously-known emails safely before rediscovering from scratch.
  // The exact address must appear on a matched public page; SERP text never counts.
  if(emailMethod==="none"&&!existingSourceBacked&&existingCandidates.length){
    const leadName=String(lead.name||lead.title||"").replace(/"/g,"").trim();
    const exactEmail=existingCandidates[0];
    const exactQueries=[
      `"${exactEmail}" "${leadName}"`,
      `"${exactEmail}" attorney`
    ];
    const exactResult=await bingFallback(lead,exactQueries,4,key,[exactEmail],0).catch(()=>null);
    if(exactResult?.emails?.length){
      emails.push(...exactResult.emails);
      combined+=" "+String(exactResult.text||"");
      source=String(exactResult.source||source||"");
      for(const email of exactResult.emails||[]){emailEvidenceSources[String(email).toLowerCase()]=String(exactResult.emailSources?.[String(email).toLowerCase()]||exactResult.source||source||"");}
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

  let researchOwnedWebsite="";

  // Run general discovery only when exact stored-email corroboration did not work.
  if(emailMethod==="none"){
    const name=String(lead.name||lead.title||"").replace(/"/g,"").trim();
    const phone=String(lead.phone||"").replace(/\D+/g,"").slice(-10);
    const city=normalizedLeadCity(lead),region=normalizedStateCode(lead)||String(lead.region||lead.state||lead.acquisition_location||"").trim();
    const people=attorneyNameVariants(lead);
    const person=people[0]||"";
    const alternate=people[1]||"";
    const barDomain=stateBarDomain(lead);
    const barQueries=stateBarQueries(lead,people);
    const state=normalizedStateCode(lead);
    const directOfficialLinks=await directOfficialProfileLinks(lead,people);
    const publicRecordQueries=[
      ...(person&&phone?[`"${person}" "${phone}" email filetype:pdf`]:[]),
      ...(name&&phone?[`"${name}" "${phone}" email`]:[]),
      ...(person?[`"${person}" "${region}" "E-mail address" filetype:pdf`]:[]),
      ...(name?[
        `"${name}" "notice to creditors" email`,
        `"${name}" "Attorney for" email`,
        `"${name}" "represented by" email`,
        `"${name}" bankruptcy email`,
        `"${name}" "legal notice" email`
      ]:[]),
      ...(person?[
        `"${person}" "notice to creditors" email`,
        `"${person}" "Attorney for" email`
      ]:[]),
      ...(state==="FL"&&person?[
        `site:floridapublicnotices.com "${person}" email`,
        `"${person}" Florida "Conflict Attorney" email filetype:pdf`
      ]:[])
    ];
    const directoryEmailQueries=[
      ...(name?[`site:trellis.law "${name}" "Email:"`]:[]),
      ...(name?[`site:docketalarm.com "${name}" "Email:"`]:[]),
      ...(person?[`site:trellis.law "${person}" "Email:"`]:[]),
      ...(person?[`site:docketalarm.com "${person}" "Email:"`]:[]),
      ...(name?[`site:lawyers.com "${name}"`]:[]),
      ...(name?[`site:findlaw.com "${name}"`]:[]),
      ...(name?[`site:attorneydir.com "${name}"`]:[]),
      ...(name?[`site:lawyer-map.com "${name}"`]:[]),
      ...(name?[`"${name}" email filetype:pdf`]:[]),
      ...(person?[`"${person}" attorney "Email:"`]:[])
    ];
    const bingQueries=[...new Set([
      // Wave 1: direct identity + authoritative/public records.
      ...(name?[`"${name}" ${city} ${region} email`.trim()]:[]),
      ...(person?[`"${person}" ${region} attorney email`.trim()]:[]),
      ...(phone&&name?[`"${name}" "${phone}" "Email"`]:[]),
      ...barQueries,
      ...directoryEmailQueries.slice(0,4),
      ...publicRecordQueries,
      ...(name?[`"${name}" email filetype:pdf`]:[]),
      ...(name?[`"${name}" "E-mail" filetype:pdf`]:[]),
      // Wave 2: broader contact/directory recovery.
      ...(name?[`"${name}" ${city} ${region} contact email`.trim()]:[]),
      ...directoryEmailQueries.slice(4),
      ...(name?[`"${name}" ${region} "E-mail"`.trim()]:[]),
      ...(phone?[`"${phone}" attorney email`]:[]),
      ...(phone&&name?[`"${name}" "${phone}"`]:[]),
      ...(alternate?[`"${alternate}" ${region} attorney email`.trim()]:[])
    ].filter(Boolean))];
    const highValue=highValueLawResearchLead(lead);
    const hasDirectOfficial=directOfficialLinks.length>0;
    const dualSearch=!hasDirectOfficial&&(highValue||emailRecoveryPriority(lead)>=5);
    const effectiveQueries=hasDirectOfficial?bingQueries.slice(0,4):bingQueries;
    // When an official directory profile is already known, do not burn dozens
    // of generic search requests first. Fetch the authoritative profile plus a
    // tiny fallback set; only fan out to multiple engines when direct lookup
    // produced no profile at all.
    const [bingResult,duckResult]=await Promise.allSettled([
      bingFallback(
        lead,
        effectiveQueries,
        hasDirectOfficial?4:(highValue?10:(dualSearch?8:7)),
        key,
        [],
        hasDirectOfficial?1:(highValue?2:1),
        directOfficialLinks
      ),
      dualSearch
        ? duckFallback({...lead,website:""},key)
        : Promise.resolve({emails:[],emailSources:{},text:"",source:"",attorneyCount:0,attorneyCountSource:"",personalFact:"",personalFactSource:""})
    ]);
    if(dualSearch&&duckResult.status==="fulfilled"){
      const targetedDuck=duckResult.value;
      emails.push(...targetedDuck.emails);
      combined+=" "+targetedDuck.text;
      if(targetedDuck.source)source=targetedDuck.source;
      for(const email of targetedDuck.emails||[]){const e=String(email).toLowerCase();emailEvidenceSources[e]=String(targetedDuck.emailSources?.[e]||targetedDuck.source||"");}
      if(targetedDuck.ownedWebsite)researchOwnedWebsite=targetedDuck.ownedWebsite;
      const tdCount=Number(targetedDuck.attorneyCount||0);
      const tdSource=String(targetedDuck.attorneyCountSource||"");
      if(tdCount>0&&isDirectPublishedEmailSource(tdSource)){
        attorneyCountVerified=true;
        if(tdCount>=attorneyCount){attorneyCount=tdCount;attorneyCountSource=tdSource;}
      }
      if(targetedDuck.personalFact){personalFact=targetedDuck.personalFact;personalFactSource=targetedDuck.personalFactSource||targetedDuck.source||"";}
      if(targetedDuck.emails.length){
        emailMethod="duck";
        await redis.hIncrBy(STATS,"email_duck_hit",1);
      }
    }

    if(bingResult.status==="fulfilled"){
      const bf=bingResult.value;
      emails.push(...bf.emails);
      combined+=" "+bf.text;
      if(bf.source)source=bf.source;
      for(const email of bf.emails||[]){const e=String(email).toLowerCase();emailEvidenceSources[e]=String(bf.emailSources?.[e]||bf.source||"");}
      if(bf.ownedWebsite)researchOwnedWebsite=bf.ownedWebsite;
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
  }

  emails=rankLawEmails(emails.map(x=>String(x).toLowerCase().trim())
    .filter(x=>isUsableLawEmail(x)&&!isThirdPartyEmailDomain(x))).slice(0,5);

  // Strong-priority Duck research already ran concurrently with Bing above.
  // Do not run a second full Duck pass here.

  emails=rankLawEmails(emails.map(x=>String(x).toLowerCase().trim())
    .filter(x=>isUsableLawEmail(x)&&!isThirdPartyEmailDomain(x))).slice(0,5);

  // Independent last-resort discovery lane. Run only after search engines miss,
  // and only when we have a plausible attorney identity. Any result still has
  // to survive exact-source binding below, so this cannot export guessed mail.
  if(!emails.length&&!researchOwnedWebsite&&attorneyNameVariants(lead).length&&emailRecoveryPriority(lead)>=5){
    try{
      const zeroCost=await zeroCostEmailFallback(lead);
      if(zeroCost.emails.length){
        emails.push(...zeroCost.emails);
        if(zeroCost.source)source=zeroCost.source;
        for(const email of zeroCost.emails||[])emailEvidenceSources[String(email).toLowerCase()]=String(zeroCost.source||"");
        emailMethod="zero_cost";
        await redis.hIncrBy(STATS,"email_zero_cost_hit",1);
      }
    }catch{
      await redis.hIncrBy(STATS,"email_zero_cost_fail",1);
    }
  }
  emails=rankLawEmails(emails.map(x=>String(x).toLowerCase().trim())
    .filter(x=>isUsableLawEmail(x)&&!isThirdPartyEmailDomain(x))).slice(0,5);

  if(researchOwnedWebsite){
    const updated={...lead,website:researchOwnedWebsite,website_opportunity:"website_refresh",owned_website_evidence_source:"research_identity_match",law_email_enrich_version:EMAIL_METHOD_VERSION};
    await redis.hSet(LEAD_HASH,key,JSON.stringify(updated));
    await Promise.all([redis.sRem(READY_SET,key),redis.sRem(EMAIL_CANDIDATE_SET,key)]);
    await redis.sAdd(REJECTED_SET,key);
    await redis.sAdd(ENRICHED_SET,key);
    await redis.hIncrBy(STATS,"owned_website_research_hit",1);
    console.log(JSON.stringify({event:"law_firm_enriched",key,name:lead.name,emails:0,emailMethod:"none",attorneyCount:null,attorneyCountVerified:false,attorneyCountSource:"",effectiveWebsite:researchOwnedWebsite,sizeTier:"unknown",practice:"",painPoint:"Has website",qualified:false,rejectReason:"has_owned_website_research",priority:0,personalizationQuality:"basic",elapsedMs:Date.now()-enrichStartedAt}));
    return true;
  }
  const rawCandidateCount=emails.length;
  if(rawCandidateCount){
    await redis.hIncrBy(STATS,"email_raw_candidate_leads",1);
    console.log(JSON.stringify({
      event:"law_email_candidate_stage",
      key,
      name:String(lead.name||lead.title||""),
      stage:"raw",
      count:rawCandidateCount,
      domains:[...new Set(emails.map(x=>String(x).split("@")[1]||""))],
      sources:[...new Set(emails.map(x=>emailEvidenceSources[String(x).toLowerCase()]||source||"").filter(Boolean))].slice(0,5)
    }));
  }
  // MX is mandatory. Identity-local-part heuristics are useful on generic web
  // pages, but an authoritative bar/court source can itself establish identity.
  // Keep those candidates alive until exact-source binding proves the address.
  const preIdentityCandidates=[...new Set(emails)];
  const checkedCandidates=await Promise.all(preIdentityCandidates.map(async email=>{
    const evidence=String(emailEvidenceSources[String(email).toLowerCase()]||source||"");
    const authoritative=lawSourceRank(evidence,lead)<=1;
    const identityOk=emailIdentityStrong(email,lead)||authoritative;
    return {email,ok:identityOk&&await hasMailExchange(email)};
  }));
  emails=checkedCandidates.filter(x=>x.ok).map(x=>x.email);
  const identityMxCount=emails.length;
  if(identityMxCount){
    await redis.hIncrBy(STATS,"email_identity_mx_pass_leads",1);
    console.log(JSON.stringify({event:"law_email_candidate_stage",key,name:String(lead.name||lead.title||""),stage:"identity_mx",count:identityMxCount}));
  }else if(rawCandidateCount)await redis.hIncrBy(STATS,"email_identity_mx_reject_leads",1);

  // Bind each candidate to the exact page that produced that address.
  // A single shared source URL caused valid emails from one engine/page to be
  // checked against a different page discovered later.
  const sourceBoundEmails=[],boundSourceByEmail={};
  for(const email of emails){
    const candidateSource=String(emailEvidenceSources[String(email).toLowerCase()]||source||"");
    const matched=await publishedEmailsOnExactSource(candidateSource,[email],lead,key);
    if(matched.length){
      sourceBoundEmails.push(email);
      boundSourceByEmail[String(email).toLowerCase()]=candidateSource;
    }
  }
  if(emails.length&&!sourceBoundEmails.length)await redis.hIncrBy(STATS,"email_source_binding_reject_leads",1);
  emails=sourceBoundEmails;

  emails=await keeleadVerifiedEmails(emails);
  if(emails.length)source=String(boundSourceByEmail[String(emails[0]).toLowerCase()]||source||"");
  if(emails.length)await redis.hIncrBy(STATS,"email_keelead_pass_leads",1);
  else if(sourceBoundEmails.length)await redis.hIncrBy(STATS,"email_keelead_reject_leads",1);
  const emailSourceVerified=emails.length>0&&isDirectPublishedEmailSource(source);
  if(emailSourceVerified)await redis.hIncrBy(STATS,"email_source_verified_leads",1);

  // Website eligibility comes before firm-size research. If the verified email
  // itself proves an owned firm domain/site, the lead is ineligible and there is
  // no reason to spend another Bing/Duck/Jina headcount pass.
  if(emailSourceVerified){
    const earlyEvidenceWebsite=await detectOwnedWebsiteFromEvidenceSource(source,emails,lead,key);
    const earlyDomainWebsite=earlyEvidenceWebsite||
      await detectOwnedWebsiteFromEmailDomains(emails,lead)||
      await findOwnedWebsitePreflight(lead,key,true);
    if(earlyDomainWebsite){
      const updated={...lead,website:earlyDomainWebsite,website_opportunity:"website_refresh",owned_website_evidence_source:"verified_email_domain",law_email_enrich_version:EMAIL_METHOD_VERSION};
      await redis.hSet(LEAD_HASH,key,JSON.stringify(updated));
      await Promise.all([redis.sRem(READY_SET,key),redis.sRem(EMAIL_CANDIDATE_SET,key)]);
      await redis.sAdd(REJECTED_SET,key);
      await redis.sAdd(ENRICHED_SET,key);
      await redis.hIncrBy(STATS,"owned_website_verified_email_hit",1);
      console.log(JSON.stringify({event:"law_firm_enriched",key,name:lead.name,emails:0,emailMethod:"none",attorneyCount:null,attorneyCountVerified:false,attorneyCountSource:"",effectiveWebsite:earlyDomainWebsite,sizeTier:"unknown",practice:"",painPoint:"Has website",qualified:false,rejectReason:"has_owned_website_verified_email",priority:0,personalizationQuality:"basic",elapsedMs:Date.now()-enrichStartedAt}));
      return true;
    }
  }

  // Conversion pass: once a real published email survives identity/MX/verifier,
  // spend extra research only on proving firm size. This is intentionally
  // conditional so we do not multiply search cost across the full backlog.
  if((emailSourceVerified||chicagoHeadcountCampaign)&&!attorneyCountVerified){
    const directorySize=await directDirectorySizeEvidence(lead,key);
    if(directorySize.website&&!website){
      const updated={...lead,website:directorySize.website,website_opportunity:"website_refresh",owned_website_evidence_source:directorySize.source||"directory"};
      await redis.hSet(LEAD_HASH,key,JSON.stringify(updated));
      await Promise.all([
        redis.sRem(READY_SET,key),
        redis.sRem(EMAIL_CANDIDATE_SET,key),
        redis.sRem(CHICAGO_PENDING_SET,key)
      ]);
      await redis.sAdd(REJECTED_SET,key);
      await redis.sAdd(ENRICHED_SET,key);
      console.log(JSON.stringify({event:"law_firm_enriched",key,name:lead.name,emails:0,emailMethod:"none",attorneyCount:directorySize.count||null,attorneyCountVerified:directorySize.count>0,attorneyCountSource:directorySize.source||"",effectiveWebsite:directorySize.website,sizeTier:firmSizeTier(directorySize.count||0),practice:"",painPoint:"Has website",qualified:false,rejectReason:"has_owned_website_directory",priority:0,personalizationQuality:"basic",elapsedMs:Date.now()-enrichStartedAt}));
      return true;
    }
    if(directorySize.count>0){
      attorneyCount=directorySize.count;
      attorneyCountVerified=true;
      attorneyCountSource=directorySize.source;
      await redis.hIncrBy(STATS,"post_email_headcount_verified",1);
      await redis.hIncrBy(STATS,"post_email_headcount_direct_directory",1);
    }
    const directSize=!attorneyCountVerified?await directLawyerComSizeEvidence(lead,key):{count:0,source:""};
    if(directSize.count>0){
      attorneyCount=directSize.count;
      attorneyCountVerified=true;
      attorneyCountSource=directSize.source;
      await redis.hIncrBy(STATS,"post_email_headcount_verified",1);
      await redis.hIncrBy(STATS,"post_email_headcount_direct_lawyercom",1);
    }
    const sizeName=String(lead.name||lead.title||"").replace(/"/g,"").trim();
    const sizeRegion=String(lead.region||lead.state||"").trim();
    const sizeQueries=sizeName?[
      `"${sizeName}" "firm size"`,
      `"${sizeName}" attorneys lawyers ${sizeRegion}`.trim(),
      `"${sizeName}" site:lawyers.com "Firm Size"`,
      `"${sizeName}" site:lawyers.com "Lawyers:"`,
      `"${sizeName}" site:martindale.com "Firm Size"`,
      `"${sizeName}" site:lawyer.com "Firm Size"`,
      `"${sizeName}" site:lawyer.com lawyers`,
      `"${sizeName}" site:justia.com attorneys`
    ]:[];
    if(sizeQueries.length&&!attorneyCountVerified){
      const headcountLead={
        ...lead,
        emails,
        law_email_source:source,
        law_email_source_verified:emailSourceVerified,
        conversion_headcount_priority:true,
        website:""
      };
      await redis.hIncrBy(STATS,"post_email_headcount_deep_priority",1);
      const [bingSize,duckSize]=await Promise.allSettled([
        bingFallback(headcountLead,sizeQueries,12,key,[],6),
        duckFallback(headcountLead,key)
      ]);
      const candidates=[];
      if(bingSize.status==="fulfilled"&&bingSize.value){
        candidates.push({
          count:Number(bingSize.value.attorneyCount||0),
          source:String(bingSize.value.attorneyCountSource||""),
          via:"bing"
        });
      }
      if(duckSize.status==="fulfilled"&&duckSize.value){
        candidates.push({
          count:Number(duckSize.value.attorneyCount||0),
          source:String(duckSize.value.attorneyCountSource||""),
          via:"duck"
        });
      }
      const verified=candidates
        .filter(x=>x.count>0&&isDirectPublishedEmailSource(x.source))
        .sort((a,b)=>{
          const aTarget=a.count>=2&&a.count<=10?0:1;
          const bTarget=b.count>=2&&b.count<=10?0:1;
          return aTarget-bTarget||b.count-a.count;
        })[0];
      if(verified){
        attorneyCount=verified.count;
        attorneyCountVerified=true;
        attorneyCountSource=verified.source;
        await redis.hIncrBy(STATS,"post_email_headcount_verified",1);
        await redis.hIncrBy(STATS,`post_email_headcount_${verified.via}`,1);
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
  const evidenceOwnedWebsite="";
  const discoveredOwnedWebsite="";
  const effectiveWebsite=website||discoveredOwnedWebsite;
  const emailCandidate=!effectiveWebsite&&emailSourceVerified&&emails.length>0&&(!attorneyCountVerified||(attorneyCount>=2&&attorneyCount<=10));
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

  const recoveryAttempts=Math.max(0,Number(lead.email_recovery_attempts||0));
  const enriched={...lead,email_recovery_attempts:recoveryAttempts,website:effectiveWebsite,emails,attorney_count_estimate:attorneyCount||null,attorney_count_evidence_verified:attorneyCountVerified,attorney_count_source:attorneyCountSource||"",preferred_firm_size:preferredSize,
    firm_size_tier:sizeTier,practice_areas:practices,practice_keys:practiceKeys,
    lead_type:practices.join(" + "),personalization_fact:p.fact,personalization_source:p.source,
    personalization_quality:p.quality,website_opportunity:"website_build",website_audit:null,primary_pain_point:painPoint,
    target_area:String(lead.acquisition_location||[lead.city,lead.region].filter(Boolean).join(", ")||"").trim(),
    email_angle:emailAngle,lead_priority_score:priority,qualified_lead:qualified,
    law_email_enrich_version:EMAIL_METHOD_VERSION,
    law_email_method:emailMethod,law_email_source:source||"",
    law_email_source_verified:emailSourceVerified,
    law_email_validation:emailSourceVerified?(KEELEAD_BASE_URL?"published_exact+strict_firm_identity+mx+optional_smtp":"published_exact+strict_firm_identity+mx"):"rejected",
    law_email_mailbox_verified:false,
    law_bar_domain:stateBarDomain(lead),
    law_firm_enriched_at:new Date().toISOString()};

  // No-email is not terminal anymore. Email discovery is the product gate:
  // give promising no-website law firms multiple research passes before rejection.
  if((!emails.length||!emailSourceVerified)&&recoveryAttempts<2){
    const recoverable={...enriched,email_recovery_attempts:recoveryAttempts+1,email_recovery_last_at:new Date().toISOString(),law_email_validation:"recovery_pending"};
    await redis.hSet(LEAD_HASH,key,JSON.stringify(recoverable));
    await Promise.all([
      redis.sRem(READY_SET,key),
      redis.sRem(REJECTED_SET,key),
      redis.sRem(ENRICHED_SET,key),
      redis.sAdd(RECOVERABLE_PENDING_SET,key)
    ]);
    await redis.hIncrBy(STATS,"email_recovery_requeued",1);
    console.log(JSON.stringify({event:"law_email_recovery_requeued",key,name:String(lead.name||lead.title||""),attempt:recoveryAttempts+1}));
    return true;
  }

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
    else if(!attorneyCountVerified) await redis.hIncrBy(STATS,"rejected_unverified_attorney_count",1);
    else if(!preferredSize) await redis.hIncrBy(STATS,"rejected_wrong_size",1);
    else if(effectiveWebsite) await redis.hIncrBy(STATS,"rejected_has_website",1);
  }
  const rejectReason=qualified?"":effectiveWebsite?"owned_website":!emails.length||!emailSourceVerified?"no_verified_email":!attorneyCountVerified?"unverified_attorney_count":!preferredSize?"wrong_size":"other";
  console.log(JSON.stringify({event:"law_firm_enriched",key,name:lead.name,emails:emails.length,emailMethod,attorneyCount:attorneyCount||null,attorneyCountVerified,attorneyCountSource:attorneyCountSource||"",effectiveWebsite:effectiveWebsite||"",sizeTier,practice:practices[0]||"",painPoint,qualified,rejectReason,priority,personalizationQuality:p.quality,elapsedMs:Date.now()-enrichStartedAt}));
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

function lawyerComFirmSlugs(lead={}){
  const slugify=value=>String(value||"")
    .toLowerCase().replace(/\b(?:esq|esquire)\.?\b/g,"")
    .replace(/&/g," and ").replace(/[^a-z0-9]+/g,"-")
    .replace(/^-+|-+$/g,"").replace(/-+/g,"-");
  const raw=String(lead.name||lead.title||"").trim();
  const person=likelyAttorneyName(lead);
  const values=[slugify(raw)];
  if(person){
    const p=slugify(person);
    values.push(p,`law-offices-of-${p}`,`law-office-of-${p}`);
  }
  return [...new Set(values.filter(Boolean))].slice(0,4);
}
function outboundFirmWebsiteFromDirectory(html="",lead={}){
  const raw=String(html||"");
  const blocked=/^(?:www\.)?(?:lawyer\.com|martindale\.com|avvo\.com|justia\.com|findlaw\.com|facebook\.com|linkedin\.com|instagram\.com|x\.com|twitter\.com|youtube\.com)$/i;
  const candidates=[];
  for(const m of raw.matchAll(/(?:https?:\/\/|www\.)[a-z0-9.-]+(?:\/[a-z0-9._~:/?#\[\]@!$&'()*+,;=%-]*)?/ig)){
    let value=String(m[0]||"").replace(/[),.;]+$/,"");
    if(/^www\./i.test(value))value="https://"+value;
    try{
      const u=new URL(value);
      const host=u.hostname.toLowerCase().replace(/^www\./,"");
      if(blocked.test(host)||lawSourceRank(u.href,lead)<=4)continue;
      if(!candidates.includes(u.origin))candidates.push(u.origin);
    }catch{}
  }
  return candidates[0]||"";
}
async function lawyerComCandidateEvidence(lead={}){
  for(const slug of lawyerComFirmSlugs(lead)){
    const url="https://www.lawyer.com/firm/"+slug+".html";
    try{
      const page=await fetchText(url,5000);
      if(!page?.html)continue;
      const text=stripHtml(page.html).slice(0,50000);
      const phone=String(lead.phone||"").replace(/\D/g,"").slice(-10);
      const identity=pageMatchesLead(text,lead,page.final_url||url)||
        Boolean(phone&&String(text).replace(/\D/g,"").includes(phone));
      if(!identity)continue;
      const count=attorneyEstimate(page.html,text);
      const website=outboundFirmWebsiteFromDirectory(page.html,lead);
      return {count,source:page.final_url||url,website};
    }catch{}
  }
  return {count:0,source:"",website:""};
}

async function cleanupEmailCandidateSet(){
  const keys=await redis.sMembers(EMAIL_CANDIDATE_SET);
  if(!keys.length)return {scanned:0,removed:0,kept:0};
  let removed=0,kept=0;
  for(let offset=0;offset<keys.length;offset+=250){
    const chunk=keys.slice(offset,offset+250);
    const values=await redis.hmGet(LEAD_HASH,chunk);
    for(let i=0;i<chunk.length;i++){
      let lead={};try{lead=values[i]?JSON.parse(values[i]):{};}catch{}
      const emails=[...(Array.isArray(lead.emails)?lead.emails:[]),lead.email]
        .map(x=>String(x||"").trim().toLowerCase())
        .filter(x=>isUsableLawEmail(x)&&!isThirdPartyEmailDomain(x));
      let discoveredWebsite=String(lead.website||lead.website_url||"").trim();
      let sourceIdentityInvalid=false;
      const candidateSource=String(lead.law_email_source||lead.email_source||lead.email_evidence_url||"").trim();
      if(values[i]&&isDirectCalBarProfile(candidateSource)){
        try{
          const page=await fetchText(candidateSource,5000);
          const html=String(page?.html||"");
          if(!html||!calBarProfileMatchesLead(stripHtml(html).slice(0,26000),lead,page?.final_url||candidateSource)){
            sourceIdentityInvalid=true;
            await redis.hIncrBy(STATS,"candidate_calbar_identity_reject",1);
          }else if(!discoveredWebsite){
            const barWebsite=calBarPublishedWebsite(html);
            if(barWebsite){
              discoveredWebsite=barWebsite;
              await redis.hIncrBy(STATS,"candidate_calbar_website_hit",1);
            }
          }
        }catch{
          sourceIdentityInvalid=true;
        }
      }
      if(!discoveredWebsite&&values[i]&&candidateSource&&isDirectPublishedEmailSource(candidateSource)&&!isDirectCalBarProfile(candidateSource)){
        try{
          const sourceRank=lawSourceRank(candidateSource,lead);
          if(sourceRank===6){
            let page=null;
            try{page=await fetchText(candidateSource,5000);}catch{}
            let evidenceHtml=String(page?.html||"");
            let evidenceUrl=String(page?.final_url||candidateSource);
            const hasDirectEvidence=()=>{
              if(!evidenceHtml)return false;
              const normalizedPage=normalizePublishedEmailText(evidenceHtml).toLowerCase();
              const exactEmail=emails.some(email=>normalizedPage.includes(String(email).toLowerCase()));
              const exactPhone=contextHasExactPhone(evidenceHtml,lead);
              return exactEmail&&exactPhone;
            };
            if(!hasDirectEvidence()){
              try{
                const jina=await callJinaReader(candidateSource,lead);
                if(jina?.html){
                  evidenceHtml=String(jina.html);
                  evidenceUrl=String(jina.final_url||candidateSource);
                  await redis.hIncrBy(STATS,"candidate_source_jina_recheck",1);
                }
              }catch{}
            }
            if(evidenceHtml){
              const pageText=stripHtml(evidenceHtml).slice(0,100000);
              let owned=ownedWebsiteFromMatchedPage(evidenceUrl,pageText,lead);
              if(!owned&&!knownThirdPartyDirectoryHost(evidenceUrl)&&hasDirectEvidence()){
                try{owned=new URL(evidenceUrl).origin;}catch{}
                if(owned)await redis.hIncrBy(STATS,"candidate_source_email_phone_owned_hit",1);
              }
              if(owned){
                discoveredWebsite=owned;
                await redis.hIncrBy(STATS,"candidate_source_owned_website_hit",1);
              }
            }
          }
        }catch{}
      }
      if(values[i]&&isLawFirmLead(lead)&&emails.length&&lead.law_email_source_verified===true){
        const directoryEvidence=await lawyerComCandidateEvidence(lead);
        if(directoryEvidence.count>0&&!lead.attorney_count_evidence_verified){
          lead={...lead,
            attorney_count_estimate:directoryEvidence.count,
            attorney_count_evidence_verified:true,
            attorney_count_source:directoryEvidence.source
          };
          await redis.hSet(LEAD_HASH,chunk[i],JSON.stringify(lead));
          await redis.hIncrBy(STATS,"candidate_lawyercom_size_hit",1);
        }
        if(!discoveredWebsite&&directoryEvidence.website){
          discoveredWebsite=directoryEvidence.website;
          await redis.hIncrBy(STATS,"candidate_lawyercom_website_hit",1);
        }
        if(!discoveredWebsite)discoveredWebsite=await detectOwnedWebsiteFromEmailDomains(emails,lead);
        if(!discoveredWebsite)discoveredWebsite=await findOwnedWebsitePreflight(lead,chunk[i],true);
      }
      if(discoveredWebsite&&!String(lead.website||lead.website_url||"").trim()){
        lead={...lead,website:discoveredWebsite,website_opportunity:"website_refresh",owned_website_evidence_source:"candidate_recheck"};
        await redis.hSet(LEAD_HASH,chunk[i],JSON.stringify(lead));
        await redis.hIncrBy(STATS,"candidate_owned_website_recheck_hit",1);
      }
      const knownCount=Number(lead.attorney_count_estimate||0);
      const knownWrongSize=lead.attorney_count_evidence_verified===true&&(knownCount<2||knownCount>10);
      const invalid=!values[i]||sourceIdentityInvalid||!isLawFirmLead(lead)||/^https?:\/\//i.test(discoveredWebsite)||
        !emails.length||lead.law_email_source_verified!==true||knownWrongSize;
      if(invalid){await redis.sRem(EMAIL_CANDIDATE_SET,chunk[i]);removed++;}
      else kept++;
    }
  }
  console.log(JSON.stringify({event:"law_email_candidate_cleanup",scanned:keys.length,removed,kept}));
  return {scanned:keys.length,removed,kept};
}

async function bootstrapExistingQualified(){
  let scanned=0,qualifiedAdded=0,qualifiedRemoved=0,queuedForEnrichment=0,alreadyQualified=0,requalifyQueued=0,historicalQualifiedMarkers=0,calbarAdapterRecoveryQueued=0,chicagoHeadcountRecoveryQueued=0;
  const fullRequalify=(await redis.get(REQUALIFY_VERSION_KEY))!==FULL_REQUAL_VERSION;
  const historicalRecovery=(await redis.get(HISTORICAL_RECOVERY_VERSION_KEY))!==HISTORICAL_RECOVERY_VERSION;
  const calbarAdapterRecovery=(await redis.get(CALBAR_ADAPTER_VERSION_KEY))!==CALBAR_ADAPTER_VERSION;
  const candidateSizeRecovery=(await redis.get(CANDIDATE_SIZE_RESEARCH_VERSION_KEY))!==CANDIDATE_SIZE_RESEARCH_VERSION;
  const chicagoHeadcountRecovery=(await redis.get(CHICAGO_HEADCOUNT_RECOVERY_KEY))!==CHICAGO_HEADCOUNT_RECOVERY_VERSION;
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
    await redis.set(HISTORICAL_RECOVERY_VERSION_KEY,HISTORICAL_RECOVERY_VERSION);
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

  if(candidateSizeRecovery){
    const candidateKeys=await redis.sMembers(EMAIL_CANDIDATE_SET);
    let candidateSizeRecoveryQueued=0;
    if(candidateKeys.length){
      for(let i=0;i<candidateKeys.length;i+=250){
        const chunk=candidateKeys.slice(i,i+250);
        await Promise.all([
          redis.sRem(ENRICHED_SET,chunk),
          redis.sRem(PRIORITY_PENDING_SET,chunk),
          redis.sRem(RECOVERABLE_PENDING_SET,chunk),
          redis.sRem(SOURCE_PENDING_SET,chunk),
          redis.sRem(SIZE_READY_PENDING_SET,chunk)
        ]);
        await redis.sAdd(PENDING_SET,chunk);
        candidateSizeRecoveryQueued+=chunk.length;
      }
    }
    await redis.set(CANDIDATE_SIZE_RESEARCH_VERSION_KEY,CANDIDATE_SIZE_RESEARCH_VERSION);
    console.log(JSON.stringify({event:"law_candidate_size_recovery_queued",candidateSizeRecoveryQueued,CANDIDATE_SIZE_RESEARCH_VERSION}));
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

      // Always prioritize Chicago no-website firms whose 2-10 headcount is
      // still unknown. This is the user's active campaign and must not sit
      // behind the nationwide historical email backlog.
      if(!website &&
         /\bchicago\b/i.test(String(lead.acquisition_location||lead.target_area||"")) &&
         lead.attorney_count_evidence_verified!==true){
        const chicagoShape=lawFirmNameShape(lead);
        if(chicagoShape!=="solo"){
          await Promise.all([
            redis.sRem(ENRICHED_SET,entry.field),
            redis.sRem(REJECTED_SET,entry.field),
            redis.sRem(RECOVERABLE_PENDING_SET,entry.field),
            redis.sRem(SOURCE_PENDING_SET,entry.field),
            redis.sRem(SIZE_READY_PENDING_SET,entry.field),
            redis.sRem(PRIORITY_PENDING_SET,entry.field),
            redis.sRem(PENDING_SET,entry.field)
          ]);
          await redis.sAdd(CHICAGO_PENDING_SET,entry.field);
        }
      }

      // One-time recovery for the Chicago website-build campaign: old runs
      // marked fresh firms enriched before proving the requested 2-10 size.
      // Re-open only no-website, firm/multi-shaped Chicago records.
      if(chicagoHeadcountRecovery && !website &&
         /\bchicago\b/i.test(String(lead.acquisition_location||lead.target_area||"")) &&
         lead.attorney_count_evidence_verified!==true){
        const shape=lawFirmNameShape(lead);
        if(shape==="multi"||shape==="firm"){
          await Promise.all([
            redis.sRem(ENRICHED_SET,entry.field),
            redis.sRem(REJECTED_SET,entry.field),
            redis.sRem(RECOVERABLE_PENDING_SET,entry.field),
            redis.sRem(SOURCE_PENDING_SET,entry.field),
            redis.sRem(SIZE_READY_PENDING_SET,entry.field)
          ]);
          await redis.sAdd(PRIORITY_PENDING_SET,entry.field);
          chicagoHeadcountRecoveryQueued++;
        }
      }

      // Direct CalBar adapter migrations retry only California no-website law
      // records. This avoids a global ~36K method requeue for source-specific
      // identity/extraction fixes.
      if(calbarAdapterRecovery&&!website&&normalizedStateCode(lead)==="CA"){
        await Promise.all([
          redis.sRem(ENRICHED_SET,entry.field),
          redis.sRem(EMAIL_CANDIDATE_SET,entry.field),
          redis.sRem(RECOVERABLE_PENDING_SET,entry.field),
          redis.sRem(SOURCE_PENDING_SET,entry.field),
          redis.sRem(SIZE_READY_PENDING_SET,entry.field)
        ]);
        await redis.sAdd(PRIORITY_PENDING_SET,entry.field);
        calbarAdapterRecoveryQueued++;
      }
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
          const methodStale=String(lead.law_email_enrich_version||"")!==EMAIL_METHOD_VERSION;
          if(!effectiveWebsite&&methodStale){
            // Method upgrades are integrity migrations, not just missing-email
            // retries. Existing "verified" candidates must be re-audited too.
            await Promise.all([
              redis.sRem(ENRICHED_SET,entry.field),
              redis.sRem(EMAIL_CANDIDATE_SET,entry.field)
            ]);
            let retrySet;
            if(emails.length)retrySet=PENDING_SET;
            else if(bootstrapSizeReady)retrySet=SIZE_READY_PENDING_SET;
            else retrySet=(highValueLawResearchLead(lead)||emailRecoveryPriority(lead)>=5)
              ? PRIORITY_PENDING_SET
              : RECOVERABLE_PENDING_SET;
            await moveToEmailQueue(entry.field,retrySet);
            queuedForEnrichment++;
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
    await redis.set(REQUALIFY_VERSION_KEY,FULL_REQUAL_VERSION);
    queuedForEnrichment+=requalifyQueued;
  }

  if(calbarAdapterRecovery)await redis.set(CALBAR_ADAPTER_VERSION_KEY,CALBAR_ADAPTER_VERSION);
  if(chicagoHeadcountRecovery)await redis.set(CHICAGO_HEADCOUNT_RECOVERY_KEY,CHICAGO_HEADCOUNT_RECOVERY_VERSION);

  console.log(JSON.stringify({
    event:"law_firm_bootstrap_existing",scanned,qualifiedAdded,qualifiedRemoved,alreadyQualified,FULL_REQUAL_VERSION,HISTORICAL_RECOVERY_VERSION,EMAIL_METHOD_VERSION,CALBAR_ADAPTER_VERSION,calbarAdapterRecoveryQueued,chicagoHeadcountRecoveryQueued,
    queuedForEnrichment,requalifyQueued,fullRequalify,
    requalifySizeReady:requalSizeReady.length,requalifyRegular:requalRegular.length,requalifyPriority:requalPriority.length,requalifyRecoverable:requalRecoverable.length,
    historicalQualifiedMarkers
  }));
  return {scanned,qualifiedAdded,qualifiedRemoved,alreadyQualified,queuedForEnrichment,requalifyQueued};
}

async function popSetBatch(setKey,count){
  // Keep work queued until enrichLead finishes. SPOP made deploy interruption
  // lossy: the lead disappeared from every queue before the job committed.
  const members=await redis.sMembers(setKey);
  return [...new Set((members||[]).filter(Boolean))].slice(0,count);
}
async function moveToEmailQueue(key,targetSet){
  await Promise.all([
    redis.sRem(CHICAGO_PENDING_SET,key),
    redis.sRem(SOURCE_PENDING_SET,key),
    redis.sRem(SIZE_READY_PENDING_SET,key),
    redis.sRem(RECOVERABLE_PENDING_SET,key),
    redis.sRem(PRIORITY_PENDING_SET,key),
    redis.sRem(PENDING_SET,key)
  ]);
  if(targetSet)await redis.sAdd(targetSet,key);
}
async function normalizeEmailQueues(){
  const [fresh,sizeReady,recoverable,priority,regular]=await Promise.all([
    redis.sMembers(SOURCE_PENDING_SET),
    redis.sMembers(SIZE_READY_PENDING_SET),
    redis.sMembers(RECOVERABLE_PENDING_SET),
    redis.sMembers(PRIORITY_PENDING_SET),
    redis.sMembers(PENDING_SET)
  ]);

  // Match the actual enrichBatch scheduling precedence exactly:
  // regular(existing email) > size-ready > priority > fresh > recoverable.
  if(regular.length){
    await Promise.all(regular.map(k=>Promise.all([
      redis.sRem(SIZE_READY_PENDING_SET,k),
      redis.sRem(PRIORITY_PENDING_SET,k),
      redis.sRem(SOURCE_PENDING_SET,k),
      redis.sRem(RECOVERABLE_PENDING_SET,k)
    ])));
  }
  if(sizeReady.length){
    await Promise.all(sizeReady.map(k=>Promise.all([
      redis.sRem(PRIORITY_PENDING_SET,k),
      redis.sRem(SOURCE_PENDING_SET,k),
      redis.sRem(RECOVERABLE_PENDING_SET,k)
    ])));
  }
  if(priority.length){
    await Promise.all(priority.map(k=>Promise.all([
      redis.sRem(SOURCE_PENDING_SET,k),
      redis.sRem(RECOVERABLE_PENDING_SET,k)
    ])));
  }
  if(fresh.length){
    await Promise.all(fresh.map(k=>redis.sRem(RECOVERABLE_PENDING_SET,k)));
  }

  // Rebalance the existing backlog against the actual paid cohort. Previous
  // versions promoted almost every solo with name+phone+state+city.
  let demotedPriority=0,promotedPriority=0;
  for(let offset=0;offset<priority.length;offset+=250){
    const chunk=priority.slice(offset,offset+250);
    const values=await redis.hmGet(LEAD_HASH,chunk);
    for(let i=0;i<chunk.length;i++){
      let lead={};try{lead=values[i]?JSON.parse(values[i]):{};}catch{}
      if(!values[i])continue;
      if(!highValueLawResearchLead(lead)&&emailRecoveryPriority(lead)<5){
        await redis.sRem(PRIORITY_PENDING_SET,chunk[i]);
        await redis.sAdd(RECOVERABLE_PENDING_SET,chunk[i]);
        demotedPriority++;
      }
    }
  }
  for(let offset=0;offset<recoverable.length;offset+=250){
    const chunk=recoverable.slice(offset,offset+250);
    const values=await redis.hmGet(LEAD_HASH,chunk);
    for(let i=0;i<chunk.length;i++){
      let lead={};try{lead=values[i]?JSON.parse(values[i]):{};}catch{}
      if(!values[i])continue;
      if(highValueLawResearchLead(lead)||emailRecoveryPriority(lead)>=5){
        await redis.sRem(RECOVERABLE_PENDING_SET,chunk[i]);
        await redis.sAdd(PRIORITY_PENDING_SET,chunk[i]);
        promotedPriority++;
      }
    }
  }

  const [freshAfter,sizeReadyAfter,recoverableAfter,priorityAfter,regularAfter]=await Promise.all([
    redis.sCard(SOURCE_PENDING_SET),
    redis.sCard(SIZE_READY_PENDING_SET),
    redis.sCard(RECOVERABLE_PENDING_SET),
    redis.sCard(PRIORITY_PENDING_SET),
    redis.sCard(PENDING_SET)
  ]);
  console.log(JSON.stringify({
    event:"law_email_queue_normalized",
    regular:regularAfter,sizeReady:sizeReadyAfter,priority:priorityAfter,fresh:freshAfter,recoverable:recoverableAfter,
    preRegular:regular.length,preSizeReady:sizeReady.length,prePriority:priority.length,preFresh:fresh.length,preRecoverable:recoverable.length,
    demotedPriority,promotedPriority
  }));
}
async function enrichBatch(){
  // Conversion-first scheduling:
  // 1) source-backed email missing size proof,
  // 2) verified 2-10 size missing an email,
  // 3) high-potential firm/multi or strong-identity email recovery,
  // 4) fresh discovery output,
  // 5) broad recovery backlog.
  // The old allocator capped PRIORITY_PENDING_SET at 6/64 even when thousands
  // of high-value leads were waiting; reserve materially more of each batch.
  // Reserve capacity for every high-value lane so a large historical backlog
  // cannot starve newly discovered firms. Fresh discovery gets a guaranteed
  // slice while email-backed and size-ready conversion work stays prioritized.
  const chicagoKeys=await popSetBatch(CHICAGO_PENDING_SET,Math.min(16,ENRICH_BATCH));
  const afterChicago=Math.max(0,ENRICH_BATCH-chicagoKeys.length);
  const regularKeys=afterChicago?await popSetBatch(PENDING_SET,Math.min(4,afterChicago)):[];
  const afterRegular=Math.max(0,afterChicago-regularKeys.length);
  const sizeReadyKeys=afterRegular?await popSetBatch(SIZE_READY_PENDING_SET,Math.min(4,afterRegular)):[];
  const afterSizeReady=Math.max(0,afterRegular-sizeReadyKeys.length);
  const freshKeys=afterSizeReady?await popSetBatch(SOURCE_PENDING_SET,Math.min(4,afterSizeReady)):[];
  const afterFresh=Math.max(0,afterSizeReady-freshKeys.length);
  const priorityKeys=afterFresh?await popSetBatch(PRIORITY_PENDING_SET,Math.min(4,afterFresh)):[];
  const afterPriority=Math.max(0,afterFresh-priorityKeys.length);
  const recoverableKeys=afterPriority?await popSetBatch(RECOVERABLE_PENDING_SET,afterPriority):[];
  const keys=[...new Set([...chicagoKeys,...regularKeys,...sizeReadyKeys,...freshKeys,...priorityKeys,...recoverableKeys])].slice(0,ENRICH_BATCH);
  if(!keys.length)return 0;
  await redis.hIncrBy(STATS,"enrich_non_destructive_batch_selected",keys.length);
  let index=0,done=0;
  const run=async()=>{
    while(index<keys.length){
      const key=keys[index++];
      try{
        const raw=await redis.hGet(LEAD_HASH,key);
        if(!raw)continue;
        let lead;try{lead=JSON.parse(raw)||{};}catch{continue;}
        const jobTimeoutMs=Math.max(30000,Math.min(120000,Number(process.env.LAW_FIRM_ENRICH_JOB_TIMEOUT_MS||75000)));
        const result=await Promise.race([
          enrichLead(key,lead),
          new Promise((_,reject)=>setTimeout(()=>reject(new Error("enrich_job_timeout_"+jobTimeoutMs)),jobTimeoutMs))
        ]);
        await Promise.all([
          redis.sRem(CHICAGO_PENDING_SET,key),
          redis.sRem(SOURCE_PENDING_SET,key),
          redis.sRem(SIZE_READY_PENDING_SET,key),
          redis.sRem(RECOVERABLE_PENDING_SET,key),
          redis.sRem(PRIORITY_PENDING_SET,key),
          redis.sRem(PENDING_SET,key)
        ]);
        if(result)done++;
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
async function lawAreaSaturated(area={}){
  const field=[normalize(area.state||""),normalize(area.city||""),"",""].join("|");
  const [attemptsRaw,newRaw,dupRaw]=await Promise.all([
    redis.hGet("recover:yield:area:attempts",field),
    redis.hGet("recover:yield:area:new",field),
    redis.hGet("recover:yield:area:duplicates",field)
  ]);
  const attempts=Number(attemptsRaw||0),netNew=Number(newRaw||0),duplicates=Number(dupRaw||0);
  const saturated=(attempts>=1&&netNew===0&&duplicates>=10) ||
    (attempts>=2&&netNew===0&&duplicates>=5) ||
    (attempts>=4&&netNew/Math.max(1,attempts)<0.5&&duplicates>=10&&duplicates>netNew*3);
  return {saturated,attempts,netNew,duplicates,field};
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
  // Raw discovery is not the bottleneck anymore. Count recoverable work too so
  // a 35K-record inventory cannot keep growing while thousands of email/headcount
  // candidates wait for enrichment.
  const activeEnrichmentBacklog=pendingPriority+pendingSource+pendingSizeReady+pendingRegular+pendingRecoverable;
  if(shouldPauseLawDiscovery({pendingEnrichment:activeEnrichmentBacklog,limit:DISCOVERY_BACKLOG_LIMIT})){
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
    const areaYield=await lawAreaSaturated(area);
    if(areaYield.saturated){
      await redis.hIncrBy(STATS,"discovery_area_saturated_skip",1);
      continue;
    }
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
await cleanupEmailCandidateSet();
startLawLeadSheetSync({
  getRedis:async()=>redis,
  serviceAccountJson:GOOGLE_SERVICE_ACCOUNT_JSON,
  spreadsheetId:LAW_LEADS_SPREADSHEET_ID,
  enabled:LAW_LEADS_SHEET_SYNC_ENABLED,
  intervalMs:LAW_LEADS_SHEET_SYNC_INTERVAL_MS
});
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
      const [queue,qualified,enrichedTotal,rejected,pending,pendingEmail,pendingRecoverable,pendingSource,websitePending,websiteReady,currentEmailCandidates,emailStats]=await Promise.all([
        redis.lLen(ACTIVE_QUEUE),redis.sCard(READY_SET),redis.sCard(ENRICHED_SET),redis.sCard(REJECTED_SET),
        redis.sCard(PENDING_SET),redis.sCard(PRIORITY_PENDING_SET),redis.sCard(RECOVERABLE_PENDING_SET),redis.sCard(SOURCE_PENDING_SET),
        redis.sCard(WEBSITE_AUDIT_PENDING_SET),redis.sCard(WEBSITE_REFRESH_READY_SET),redis.sCard(EMAIL_CANDIDATE_SET),
        redis.hmGet(STATS,["email_existing_hit","email_duck_hit","email_bing_hit","email_zero_cost_hit","email_no_hit","scrapling_source_hit","scrapling_source_fail","email_verifier_unavailable","scrapling_search_hit","bing_source_links","bing_source_pages_matched","bing_source_email_pages","email_raw_candidate_leads","email_identity_mx_pass_leads","email_identity_mx_reject_leads","email_keelead_pass_leads","email_keelead_reject_leads","email_source_verified_leads","jina_source_hit","jina_source_fail","email_existing_recorroborated","email_existing_recorroboration_miss","post_email_headcount_verified","post_email_headcount_miss","post_email_headcount_bing","post_email_headcount_duck","rejected_no_verified_email","rejected_unverified_attorney_count","rejected_wrong_size","rejected_has_website","scrapling_static_hit","scrapling_static_fail","bing_queries_with_links","bing_source_page_fetch_reject","bing_rss_query_hit","bing_query_fetch_reject","bing_fallback_error","email_source_binding_reject_leads","scrapling_generic_skip","owned_website_research_hit","website_preflight_hit","website_preflight_miss","bar_query_hit","bar_source_page_matched","bar_email_page","email_zero_cost_fail","email_source_binding_page_miss","email_source_binding_identity_reject","email_source_binding_exact_email_miss","email_source_binding_fetch_error","website_preflight_deferred","scrapling_browser_skip","bing_relative_result_links","scrapling_broad_discovery_skip","bing_source_raw_email_pages","bing_source_context_reject_email_pages","duck_source_raw_email_pages","duck_source_context_reject_email_pages","owned_website_verified_email_hit","bing_generic_link_reject","calbar_decoy_email_reject","bing_trusted_link_reject","expected_bar_query_with_links","expected_bar_result_links","expected_bar_page_matched","expected_bar_email_page","yahoo_expected_bar_query_hit","yahoo_expected_bar_result_links","yahoo_expected_bar_query_miss","yahoo_expected_bar_fetch_error","expected_bar_eligible_query_checks","expected_bar_query_executed","expected_bar_state_direct","expected_bar_state_derived","direct_calbar_search_attempt","direct_calbar_profile_links","direct_calbar_search_error","direct_calbar_page_matched","direct_calbar_email_page","candidate_owned_website_recheck_hit","calbar_profile_identity_reject","calbar_profile_website_hit","candidate_calbar_identity_reject","candidate_calbar_website_hit","owner_name_firm_label_bypass","direct_calbar_unique_profile","direct_calbar_deep_read_attempt","direct_calbar_deep_read_match","enrich_non_destructive_batch_selected","direct_calbar_deep_read_chars","direct_calbar_active_from_search","direct_calbar_unique_active","calbar_strong_email_accept","direct_calbar_search_identity_reject","direct_lawyercom_size_attempt","direct_lawyercom_size_hit","direct_lawyercom_size_miss","post_email_headcount_direct_lawyercom","candidate_source_owned_website_hit","candidate_lawyercom_size_hit","candidate_lawyercom_website_hit"])
      ]);
      console.log(JSON.stringify({
        event:"law_firm_pipeline_cycle",seeded:null,enriched,queue,qualified,enrichedTotal,rejected,pending,pendingEmail,pendingRecoverable,pendingSource,websitePending,websiteReady,
        emailExisting:Number(emailStats?.[0]||0),emailDuck:Number(emailStats?.[1]||0),emailBing:Number(emailStats?.[2]||0),
        emailZeroCost:Number(emailStats?.[3]||0),emailNoHit:Number(emailStats?.[4]||0),
        scraplingSourceHit:Number(emailStats?.[5]||0),scraplingSourceFail:Number(emailStats?.[6]||0),
        emailVerifierUnavailable:Number(emailStats?.[7]||0),scraplingSearchHit:Number(emailStats?.[8]||0),
        bingSourceLinks:Number(emailStats?.[9]||0),bingSourcePagesMatched:Number(emailStats?.[10]||0),
        bingSourceEmailPages:Number(emailStats?.[11]||0),
        emailRawCandidateAttempts:Number(emailStats?.[12]||0),emailIdentityMxPassAttempts:Number(emailStats?.[13]||0),
        emailIdentityMxRejectAttempts:Number(emailStats?.[14]||0),emailKeeleadInfrastructurePassAttempts:Number(emailStats?.[15]||0),
        emailKeeleadInfrastructureRejectAttempts:Number(emailStats?.[16]||0),emailSourceVerifiedAttempts:Number(emailStats?.[17]||0),currentEmailCandidates,jinaSourceHit:Number(emailStats?.[18]||0),jinaSourceFail:Number(emailStats?.[19]||0),emailExistingRecorroborated:Number(emailStats?.[20]||0),emailExistingRecorroborationMiss:Number(emailStats?.[21]||0),postEmailHeadcountVerified:Number(emailStats?.[22]||0),postEmailHeadcountMiss:Number(emailStats?.[23]||0),
        postEmailHeadcountBing:Number(emailStats?.[24]||0),postEmailHeadcountDuck:Number(emailStats?.[25]||0),
        rejectedNoVerifiedEmail:Number(emailStats?.[26]||0),rejectedUnverifiedAttorneyCount:Number(emailStats?.[27]||0),
        rejectedWrongSize:Number(emailStats?.[28]||0),rejectedHasWebsite:Number(emailStats?.[29]||0),
        scraplingStaticHit:Number(emailStats?.[30]||0),scraplingStaticFail:Number(emailStats?.[31]||0),bingQueriesWithLinks:Number(emailStats?.[32]||0),bingSourcePageFetchReject:Number(emailStats?.[33]||0),bingRssQueryHit:Number(emailStats?.[34]||0),bingQueryFetchReject:Number(emailStats?.[35]||0),bingFallbackError:Number(emailStats?.[36]||0),emailSourceBindingRejectLeads:Number(emailStats?.[37]||0),scraplingGenericSkip:Number(emailStats?.[38]||0),ownedWebsiteResearchHit:Number(emailStats?.[39]||0),websitePreflightHit:Number(emailStats?.[40]||0),websitePreflightMiss:Number(emailStats?.[41]||0),barQueryHit:Number(emailStats?.[42]||0),barSourcePageMatched:Number(emailStats?.[43]||0),barEmailPage:Number(emailStats?.[44]||0),emailZeroCostFail:Number(emailStats?.[45]||0),emailSourceBindingPageMiss:Number(emailStats?.[46]||0),emailSourceBindingIdentityReject:Number(emailStats?.[47]||0),emailSourceBindingExactEmailMiss:Number(emailStats?.[48]||0),emailSourceBindingFetchError:Number(emailStats?.[49]||0),websitePreflightDeferred:Number(emailStats?.[50]||0),scraplingBrowserSkip:Number(emailStats?.[51]||0),bingRelativeResultLinks:Number(emailStats?.[52]||0),scraplingBroadDiscoverySkip:Number(emailStats?.[53]||0),bingSourceRawEmailPages:Number(emailStats?.[54]||0),bingSourceContextRejectEmailPages:Number(emailStats?.[55]||0),duckSourceRawEmailPages:Number(emailStats?.[56]||0),duckSourceContextRejectEmailPages:Number(emailStats?.[57]||0),ownedWebsiteVerifiedEmailHit:Number(emailStats?.[58]||0),bingGenericLinkReject:Number(emailStats?.[59]||0),calbarDecoyEmailReject:Number(emailStats?.[60]||0),bingTrustedLinkReject:Number(emailStats?.[61]||0),expectedBarQueryWithLinks:Number(emailStats?.[62]||0),expectedBarResultLinks:Number(emailStats?.[63]||0),expectedBarPageMatched:Number(emailStats?.[64]||0),expectedBarEmailPage:Number(emailStats?.[65]||0),yahooExpectedBarQueryHit:Number(emailStats?.[66]||0),yahooExpectedBarResultLinks:Number(emailStats?.[67]||0),yahooExpectedBarQueryMiss:Number(emailStats?.[68]||0),yahooExpectedBarFetchError:Number(emailStats?.[69]||0),expectedBarEligibleQueryChecks:Number(emailStats?.[70]||0),expectedBarQueryExecuted:Number(emailStats?.[71]||0),expectedBarStateDirect:Number(emailStats?.[72]||0),expectedBarStateDerived:Number(emailStats?.[73]||0),directCalbarSearchAttempt:Number(emailStats?.[74]||0),directCalbarProfileLinks:Number(emailStats?.[75]||0),directCalbarSearchError:Number(emailStats?.[76]||0),directCalbarPageMatched:Number(emailStats?.[77]||0),directCalbarEmailPage:Number(emailStats?.[78]||0),candidateOwnedWebsiteRecheckHit:Number(emailStats?.[79]||0),calbarProfileIdentityReject:Number(emailStats?.[80]||0),calbarProfileWebsiteHit:Number(emailStats?.[81]||0),candidateCalbarIdentityReject:Number(emailStats?.[82]||0),candidateCalbarWebsiteHit:Number(emailStats?.[83]||0),ownerNameFirmLabelBypass:Number(emailStats?.[84]||0),directCalbarUniqueProfile:Number(emailStats?.[85]||0),directCalbarDeepReadAttempt:Number(emailStats?.[86]||0),directCalbarDeepReadMatch:Number(emailStats?.[87]||0),enrichNonDestructiveBatchSelected:Number(emailStats?.[88]||0),directCalbarDeepReadChars:Number(emailStats?.[89]||0),directCalbarActiveFromSearch:Number(emailStats?.[90]||0),directCalbarUniqueActive:Number(emailStats?.[91]||0),calbarStrongEmailAccept:Number(emailStats?.[92]||0),directCalbarSearchIdentityReject:Number(emailStats?.[93]||0),directLawyercomSizeAttempt:Number(emailStats?.[94]||0),directLawyercomSizeHit:Number(emailStats?.[95]||0),directLawyercomSizeMiss:Number(emailStats?.[96]||0),postEmailHeadcountDirectLawyercom:Number(emailStats?.[97]||0),candidateSourceOwnedWebsiteHit:Number(emailStats?.[98]||0),candidateLawyercomSizeHit:Number(emailStats?.[99]||0),candidateLawyercomWebsiteHit:Number(emailStats?.[100]||0),candidateSourceEmailPhoneOwnedHit:Number(emailStats?.[101]||0),candidateSourceJinaRecheck:Number(emailStats?.[102]||0)
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
