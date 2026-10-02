// deployment trigger: activate law enrichment worker for Chicago MCP validation 2026-09-30
// deployment trigger: law email-v37 current-head snapshot 2026-09-30
import { createClient } from "redis";
import { randomUUID } from "node:crypto";
import { resolveMx } from "node:dns/promises";
import { orchestrate as enrichProfessionalEmail } from "email-enrich";
import { LAW_PRACTICES, lawFirmPracticeAreas, lawFirmPracticeKeys, TARGET_LAW_PRACTICES, qualifiesNoWebsiteLawLead, shouldPauseLawDiscovery, lawResearchQueries, isUsableLawEmail, isUsableLawPhone, normalizeLawPhone, isLawFirmLead } from "./law-firm-targeting.mjs";
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
const ENRICH_BATCH=Math.max(1,Math.min(256,Number(process.env.LAW_FIRM_ENRICH_BATCH||96)));
const ENRICH_CONCURRENCY=Math.max(1,Math.min(80,Number(process.env.LAW_FIRM_ENRICH_CONCURRENCY||32)));
const SIZE_READY_EMAIL_BATCH=Math.max(4,Math.min(96,Number(process.env.LAW_SIZE_READY_EMAIL_BATCH||48)));
const SIZE_READY_EMAIL_CONCURRENCY=Math.max(2,Math.min(48,Number(process.env.LAW_SIZE_READY_EMAIL_CONCURRENCY||24)));
const EMAIL_METHOD_VERSION="email-v67-recovery-diversity-free-mail";
const SIZE_READY_EMAIL_METHOD_VERSION="size-ready-email-v4-headcount-roster-identities";
const FULL_REQUAL_VERSION=String(process.env.LAW_FULL_REQUAL_VERSION||"eligibility-v1");
const HISTORICAL_RECOVERY_VERSION=String(process.env.LAW_HISTORICAL_RECOVERY_VERSION||"historical-v1");
const CHICAGO_HEADCOUNT_RECOVERY_VERSION="chicago-headcount-v2";
const CHICAGO_HEADCOUNT_RECOVERY_KEY="recover:law-firm:chicago-headcount-recovery-version";
const ASSOCIATION_DOCKET_RECOVERY_VERSION="association-docket-v6-firm-owner-guard";
const ASSOCIATION_DOCKET_RECOVERY_KEY="recover:law-firm:association-docket-recovery-version";
const SIZE_READY_WEBSITE_AUDIT_VERSION="size-ready-website-audit-v5-consistency";
const SIZE_READY_WEBSITE_AUDIT_KEY="recover:law-firm:size-ready-website-audit-version";
const MX_CACHE=new Map();
function withDeadline(promise,timeoutMs,label="operation"){
  let timer;
  const timeout=new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error(label+" timed out after "+timeoutMs+"ms")),timeoutMs);
    if(typeof timer?.unref==="function")timer.unref();
  });
  return Promise.race([promise,timeout]).finally(()=>{if(timer)clearTimeout(timer);});
}
async function hasMailExchange(email=""){
  const domain=String(email).split("@")[1]?.toLowerCase()||"";
  if(!domain)return false;
  if(MX_CACHE.has(domain))return MX_CACHE.get(domain);
  let ok=false;
  try{
    const mx=await withDeadline(resolveMx(domain),6000,"mx:"+domain);
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

async function publishedEmailEvidenceFromHeadcountSource(lead={},key=""){
  const source=String(lead.attorney_count_source||"").trim();
  if(!source||!isDirectPublishedEmailSource(source))return {emails:[],source:""};
  try{
    const page=await fetchResearchPage(source,lead,key,true);
    if(!page?.html)return {emails:[],source:""};
    const finalUrl=String(page.final_url||source);
    const text=stripHtml(page.html).slice(0,60000);
    if(!pageMatchesLead(text,lead,finalUrl))return {emails:[],source:""};

    // The same identity-matched headcount page can also expose the firm's
    // actual attorney roster. Preserve those names even when the page has no
    // email so the subsequent public-record/bar searches use real attorneys
    // instead of repeatedly searching only the generic firm label.
    const attorneyNames=strictFirmPageRosterNames(page.html,finalUrl,lead);
    if(attorneyNames.length){
      await redis.hIncrBy(STATS,"headcount_source_roster_identity_hit",attorneyNames.length);
    }

    const candidates=contextualEmails(page.html,lead,finalUrl)
      .filter(email=>isUsableLawEmail(email)&&!isThirdPartyEmailDomain(email));
    if(!candidates.length)return {emails:[],source:finalUrl,attorneyNames};

    const checked=await Promise.all([...new Set(candidates)].slice(0,6).map(async email=>({
      email,ok:await hasMailExchange(email)
    })));
    const emails=checked.filter(x=>x.ok).map(x=>x.email);
    if(!emails.length)return {emails:[],source:finalUrl,attorneyNames};

    await redis.hIncrBy(STATS,"headcount_source_email_fastpath_hit",1);
    console.log(JSON.stringify({
      event:"law_headcount_source_email_fastpath_hit",
      key,name:String(lead.name||lead.title||""),
      source:finalUrl,emails:emails.slice(0,3)
    }));
    return {emails:rankLawEmails(emails).slice(0,5),source:finalUrl,attorneyNames};
  }catch(error){
    await redis.hIncrBy(STATS,"headcount_source_email_fastpath_error",1);
    return {emails:[],source:""};
  }
}

async function publishedEmailsOnExactSource(source="",emails=[],lead={},key=""){
  const tagged=(values,status)=>{const out=[...(values||[])];out.bindingStatus=status;return out;};
  if(!isDirectPublishedEmailSource(source)||!emails.length)return tagged([],"invalid");
  try{
    const page=await fetchResearchPage(source,lead,key,true);
    if(!page?.html){
      await redis.hIncrBy(STATS,"email_source_binding_page_miss",1);
      return tagged([],"unavailable");
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
    return tagged(matched,matched.length?"matched":"disproven");
  }catch(error){
    await redis.hIncrBy(STATS,"email_source_binding_fetch_error",1);
    console.warn(JSON.stringify({event:"law_email_source_binding_error",key,error:String(error?.message||error).slice(0,240)}));
    return tagged([],"error");
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
let scraplingBrowserBusy=false;
async function withScraplingBrowserSlot(fn){
  // Browser stealth is only a fallback after direct/Jina/static reads. Never
  // build an unbounded FIFO here: with 64 enrichers, one 16s browser slot can
  // otherwise turn into a 15+ minute queue and stall the whole enrichment batch.
  if(scraplingBrowserBusy)return null;
  scraplingBrowserBusy=true;
  try{return await fn();}finally{scraplingBrowserBusy=false;}
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
const CALBAR_ADAPTER_VERSION="calbar-v11-phone-identity-before-status";
const CALBAR_ADAPTER_VERSION_KEY="recover:law-firm:calbar-adapter-version";
const FLORIDA_DIRECT_RECOVERY_VERSION="florida-direct-firm-v4-top-priority";
const FLORIDA_DIRECT_RECOVERY_KEY="recover:law-firm:florida-direct-recovery-version";
const CANDIDATE_SIZE_RESEARCH_VERSION="candidate-size-v10-cross-source-roster";
const CANDIDATE_SIZE_RESEARCH_VERSION_KEY="recover:law-firm:candidate-size-research-version";
const HISTORICAL_QUALIFIED_KEYS=new Set(["place:ChIJ-U4jzLpzaYgRiuVOJexcUts","place:ChIJ-cZwjdl814kR3naYgZCQKWI","place:ChIJ205yYu_UyFQRWo9oRpd3T-M","place:ChIJ2ROk0Extq4kRBT2E7-tRYlw","place:ChIJ32Qgyr7wtocRGWTUwdhYGTk","place:ChIJ3QySmg_HmoARkctGxRlocHU","place:ChIJ3W-ACwxx44kR2rru4m1yG4A","place:ChIJ4W_J98Jv54gRGvAwT50QYxA","place:ChIJ4fF-dR4YhYARuNJj2qaVxFc","place:ChIJ5WPlZJCNwokRIEUL9eDQOZw","place:ChIJ5wdWFlsyMYYRWPy3nw0m03A","place:ChIJ5z3GsvfFvIcRO0k17OFS-74","place:ChIJ71pJNPiKR4gRLhF2R_ErKEk","place:ChIJ7cSewURXwokRJYKLE-zxnBw","place:ChIJ7wsutdx4bIcR6p_AksLnRyw","place:ChIJ95gGZEgg6IgRZsn5pby6rpE","place:ChIJ9zP3h5kSAIkRdWMOrKTPeI8","place:ChIJA9HEiW7rJIYR95Qpcp4Lgvg","place:ChIJAQBkSoYo3YARpPJt5RHVTWY","place:ChIJAyCOMGLOw4kR7YvAi7XZ_H4","place:ChIJBVc_u6i2hYARiPAijtV8dAY","place:ChIJD6vum6RfQogRdNScZ6vQ5Zs","place:ChIJDyWvCZZXwokRTcTR4Oj1oKQ","place:ChIJE4PSX6raxokR91IKiYlqp9k","place:ChIJF31O_YIEU4cRpSPVKS9wwtY","place:ChIJFU2oKxYzMYYRebQBKdNNm0g","place:ChIJG1VBA1HxNIgRGAJy-YLCIhI","place:ChIJGWLs2eTQhIARV7GeoY81EcE","place:ChIJH8ORLCxfVFMRiTs-1FsCUGk","place:ChIJHfJFQjomwokRSql3ngElZ5M","place:ChIJIXOHPySX-IgRBKF_bc-rke0","place:ChIJJzoh2FyGmYcRN71FnFcpY00","place:ChIJK7eQx4j5Y4gRb9qliaeIfQg","place:ChIJKYY8pmLnmoARE4mULG2YnNs","place:ChIJKer573eoZYYRC-qFdZ_Eg3A","place:ChIJKw02pnLRhIARPEIfaW4NNg0","place:ChIJLTBYQhSrw4kRMnKH-0QzcG8","place:ChIJLyxfboWMk4cRf66FH6ritxo","place:ChIJM02Gea1YXIYRyvJ5ZwPhoQw","place:ChIJM6BqOO0wq4kRTae0vIkDBVo","place:ChIJM_1lHE5ZVFMRwH1fHLVGt34","place:ChIJMbp75upAwFQRe2uTudVjsow","place:ChIJN7r7r72awoARjAesAtfbDLw","place:ChIJNycr3iOHmYcRXquelBr03KE","place:ChIJO7QVTAluAHwRVsaeyJtxK7A","place:ChIJO7lK00vF54gRQ8j3zzWyLwU","place:ChIJPRt57X_d9YgRI5UYwRJE_2U","place:ChIJQ3oMBtrRUIgR65BnUyVPft4","place:ChIJRVH9a48Tt4cR6SOOdv3Edck","place:ChIJRW1H7r3VFogRlFoHqpncZ0I","place:ChIJRYrj7X3pwogRdG_E9PJYcf0","place:ChIJTa7FEGNQ4IYRSydBoKqsl2o","place:ChIJUYXwNCnaNYgRjAdaoH_ogLw","place:ChIJVYdWQ-4Cw4kRr4bAd6NLQVY","place:ChIJVxw7O9jeJIgR1FiEkRQhZLI","place:ChIJY6aHQLRcfYcRKiqiFK5w0do","place:ChIJayky0_XFvIcRjdDZMkHLRD8","place:ChIJb2hcRZsU3okR_EKIIlGOyw8","place:ChIJb3hWSBZv_4gROY_ApeSM8wU","place:ChIJbxKvvzbu2YkRMdteRtp7klE","place:ChIJd1aP8_KVlocR8_cIhc_Dsd0","place:ChIJdTzQCQJ5hYARdGR1UtB9dkE","place:ChIJeXm0tUXM3IARGzqfb3eOmCY","place:ChIJf2DHHpm3D4gRXfghePyBLmk","place:ChIJfyFrYXdVwIcRYhnjhZT1owA","place:ChIJgx6wDyjpaIgRAC-jEra5Hjw","place:ChIJi87TdvdvwokRjr-8f8K3FG0","place:ChIJjcnM45EgnYgREsRlrRsiyGg","place:ChIJkTUAzFFwzoARxKluSnPRdWQ","place:ChIJl6VxtjJBZIgRBc4VIABoDiw","place:ChIJmbFHSgiQhYAR0v11xfpj4bw","place:ChIJn5Qcag_1UocRtfKl2ZxDBug","place:ChIJnQ8ijF_v44kRFNChrD1otkQ","place:ChIJo-hS02IU7IARMFpv8tr4RTY","place:ChIJpWJorhCs0IkRRcYffMNkoeI","place:ChIJqSz5ytfMwoARZvRZn84vWmI","place:ChIJr104108HYIgRkJT9GlF7xKw","place:ChIJs4frIbQakFQRQPUW66WTiH4","place:ChIJsRDfI5BBZIgR4v0gkMlYNgA","place:ChIJsewYiPRp6oAR6fKhe5QIWcY","place:ChIJt4aEWsHfyFYRT_jYSgVRVw4","place:ChIJt9fh31NZ54YR5ZyCFBn9ock","place:ChIJtRjaRPXgtYcR2V6WyoGvW6g","place:ChIJuzD2vZYT2YkR7dqgvdWC6DY","place:ChIJxUWzCxINkIARDdm6uFNIS-E","place:ChIJzWyZs58FU4gR5-_YQva8wr4"]);
const REJECTED_SET="recover:law-firm:rejected:v3";
const PENDING_SET="recover:law-firm:enrich-pending:v3";
const SIZE_READY_PENDING_SET="recover:law-firm:size-ready-pending:v1";
const PRIORITY_PENDING_SET="recover:law-firm:enrich-priority:v3";
const RECOVERABLE_PENDING_SET="recover:law-firm:enrich-recoverable:v1";
const SOURCE_PENDING_SET="recover:law-firm:enrich-pending:v2";
const CHICAGO_PENDING_SET="recover:law-firm:chicago-priority:v1";
const PHONE_HEADCOUNT_PRIORITY_SET="recover:law-firm:phone-headcount-priority:v1";
const PHONE_HEADCOUNT_METHOD_VERSION="phone-headcount-v9-lawyercom-slug-variants";
const UNIQUE_VERIFIED_EMAIL_SET="recover:law-firm:unique-verified-email:v1";
const VERIFIED_EMAIL_EVIDENCE_HASH="recover:law-firm:verified-email-evidence:v1";
const VERIFIED_HEADCOUNT_EVIDENCE_HASH="recover:law-firm:verified-headcount-evidence:v1";
const UNIQUE_VERIFIED_HEADCOUNT_SET="recover:law-firm:unique-verified-headcount:v1";
const CALL_READY_SET="recover:law-firm:call-ready:v1";
const UNIQUE_ELIGIBLE_SET="recover:law-firm:unique-eligible:v1";
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
const DIRECTORY_DISCOVERY_ENABLED=String(process.env.LAW_DIRECTORY_DISCOVERY_ENABLED||"true").toLowerCase()!=="false";
const DIRECTORY_DISCOVERY_BATCH=Math.max(1,Math.min(8,Number(process.env.LAW_DIRECTORY_DISCOVERY_BATCH||6)));
const DIRECTORY_DISCOVERY_PAGES=Math.max(1,Math.min(4,Number(process.env.LAW_DIRECTORY_DISCOVERY_PAGES||2)));
const DIRECTORY_DISCOVERY_MAX_PAGES=Math.max(DIRECTORY_DISCOVERY_PAGES,Math.min(6,Number(process.env.LAW_DIRECTORY_DISCOVERY_MAX_PAGES||4)));
// v3 restarts source-first directory coverage after the prior v2 frontier was
// exhausted. This lane is the fastest way to acquire leads that are already
// explicitly published as 2-10 attorneys instead of proving size from raw Maps
// records one firm at a time.
const DIRECTORY_CURSOR_KEY="recover:law-firm:lawyerscom-directory-cursor:v3";
const DIRECTORY_SEEDED_SET="recover:law-firm:lawyerscom-directory-seeded:v3";
const STATS="recover:law-firm:stats:v3";
let INDEXED_HEADCOUNT_DIAGNOSTICS=0;
const PROFILE={industry:"LAW_FIRM",require_phone:true,require_email:false,require_contact:true,require_no_website:true,include_no_website:true,min_score:45};
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
async function emitCallReadySnapshot(){
  const keys=await redis.sMembers(UNIQUE_VERIFIED_HEADCOUNT_SET);
  let matches=0,withEmail=0;
  for(let offset=0;offset<keys.length;offset+=250){
    const chunk=keys.slice(offset,offset+250);
    const values=await redis.hmGet(LEAD_HASH,chunk);
    for(let i=0;i<chunk.length;i++){
      if(!values[i])continue;
      let lead;try{lead=JSON.parse(values[i])||{};}catch{continue;}
      const isLaw=String(lead.search_profile||"")==="law-firm"||String(lead.industry||"").toUpperCase()==="LAW_FIRM";
      const website=String(lead.website||lead.website_url||"").trim();
      const attorneyCount=Number(lead.attorney_count_estimate||lead.attorney_count||0);
      const sizeReady=lead.attorney_count_evidence_verified===true&&attorneyCount>=2&&attorneyCount<=10;
      const phone=String(lead.phone||"").trim();
      if(!isLaw||/^https?:\/\//i.test(website)||!sizeReady||!isUsableLawPhone(phone)){await redis.sRem(CALL_READY_SET,chunk[i]);continue;}
      await redis.sAdd(CALL_READY_SET,chunk[i]);
      const emails=[...(Array.isArray(lead.emails)?lead.emails:[]),lead.email]
        .map(x=>String(x||"").trim().toLowerCase())
        .filter(x=>isUsableLawEmail(x));
      const emailEligible=emails.length>0&&(lead.law_email_source_verified===true||lead.email_source_verified===true);
      if(emailEligible)withEmail++;
      matches++;
      console.log(JSON.stringify({
        event:"law_call_ready_export",
        key:chunk[i],
        firm:String(lead.name||lead.title||"").trim(),
        phone,
        normalizedPhone:normalizeLawPhone(phone),
        email:emailEligible?(emails[0]||""):"",
        emailEligible,
        city:String(lead.city||"").trim(),
        state:String(lead.region||lead.state||"").trim().toUpperCase(),
        attorneys:attorneyCount,
        headcountSource:String(lead.attorney_count_source||"").trim(),
        address:String(lead.address||"").trim(),
        maps:String(lead.google_maps_url||lead.maps_url||"").trim(),
        priority:Number(lead.lead_priority_score||0)||0,
        practiceKeys:Array.isArray(lead.practice_keys)?lead.practice_keys:[],
        practiceAreas:Array.isArray(lead.practice_areas)?lead.practice_areas:[],
        personalAngle:String(lead.personalization_fact||"").trim(),
        source:emailEligible?String(lead.law_email_source||lead.email_source||"").trim():String(lead.attorney_count_source||lead.personalization_source||lead.google_maps_url||lead.maps_url||"").trim()
      }));
    }
  }
  console.log(JSON.stringify({event:"law_call_ready_export_summary",verifiedHeadcountSet:keys.length,matches,withEmail}));
}
await emitCallReadySnapshot().catch(error=>console.error("law_call_ready_export_error",error?.message||error));
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
    const sourceRich=["FL","TX","CA","GA","IL","NC","WA"];
    const sourceRank=new Map(sourceRich.map((state,index)=>[state,index]));
    const states=[...byState.keys()].sort((a,b)=>{
      const ar=sourceRank.has(a)?sourceRank.get(a):999;
      const br=sourceRank.has(b)?sourceRank.get(b):999;
      return ar-br||a.localeCompare(b);
    });
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
  // Strict-qualified yield is currently email-bound. Front-load cities in
  // states where public bar profiles expose stronger contact evidence, while
  // preserving the existing population-band ordering inside each bucket.
  // This changes research order only; the same national city frontier remains.
  const strictSourceStateOrder=["FL","CA","TX","GA","IL","NC","WA"];
  const strictRank=new Map(strictSourceStateOrder.map((state,index)=>[state,index]));
  const sourceRich=result.filter(x=>strictRank.has(x.state))
    .sort((a,b)=>strictRank.get(a.state)-strictRank.get(b.state));
  const rest=result.filter(x=>!strictRank.has(x.state));
  return [...sourceRich,...rest].slice(0,MAX_CITIES);
}
async function fetchText(url,timeout=FETCH_TIMEOUT_MS){
  const ctl=new AbortController(), timer=setTimeout(()=>ctl.abort(),timeout);
  const started=Date.now();
  try{
    const isCalBar=/https?:\/\/apps\.calbar\.ca\.gov\/attorney\//i.test(String(url||""));
    const isSearchEngine=/https?:\/\/(?:www\.)?(?:google|bing)\.com\//i.test(String(url||""))||/https?:\/\/html\.duckduckgo\.com\//i.test(String(url||""));
    const requestHeaders=(isCalBar||isSearchEngine)?{
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
      const pdfOrProfessional=/\.pdf(?:$|[?#])/i.test(String(url))||professionalDirectoryUrlLikely(url);
      // Association/member PDFs can be long and the target firm may appear
      // well beyond the first 24k chars. Keep normal pages cheap, but allow a
      // deeper public-text window for these high-yield source types.
      const jinaText=directCalBar
        ? fullJinaText.slice(0,220000)
        : pdfOrProfessional
          ? fullJinaText.slice(0,180000)
          : fullJinaText.slice(0,24000);
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
  const explicitLooksLikeFirm=/\b(law offices?|law office|law firm|attorneys? at law|legal group|legal services|associates?|partners?|group|llc|pllc|p\.?c\.?|llp|apc)\b/i.test(explicit);
  const explicitGenericRole=/^(?:at law|attorney at law|attorney|lawyer|owner|partner|principal|founder|manager|member)$/i.test(explicit);
  if(explicitRaw&&(explicitLooksLikeFirm||explicitGenericRole))void redis.hIncrBy(STATS,"owner_name_firm_label_bypass",1).catch(()=>{});
  if(explicit&&!explicitLooksLikeFirm&&!explicitGenericRole&&explicit.split(/\s+/).length>=2&&explicit.split(/\s+/).length<=5)return explicit;
  const raw=String(lead.name||lead.title||"").replace(/\s+/g," ").trim();
  if(!raw)return "";

  // Maps often stores the actual attorney after a firm label, e.g.
  // "Naugle Law Offices: Naugle Cathy L" or "Howes Law Firm | John Titler".
  // Promote that person into the core identity parser so free-mail/public
  // source verification uses the same attorney identity as search discovery.
  const suffixPerson=raw.match(/(?:[:|]|\s[-–—]\s)\s*([A-Z][A-Za-z.'’\-]+(?:\s+[A-Z][A-Za-z.'’\-]+){1,4})\s*$/);
  if(suffixPerson?.[1]){
    const candidate=String(suffixPerson[1]).replace(/\s+/g," ").trim();
    const parts=candidate.split(/\s+/);
    if(parts.length>=2&&parts.length<=5&&!/\b(law|office|firm|group|associates|partners|legal|services|attorney|lawyer)\b/i.test(candidate)){
      return candidate;
    }
  }

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
  const values=[];
  const raw=String(lead.name||lead.title||"").replace(/\s+/g," ").trim();
  const addPerson=(candidate="")=>{
    const cleaned=String(candidate||"")
      .replace(/\b(?:esq(?:uire)?|attorneys?|lawyers?|counselors?|counsel|at law|law offices?|law firm|llc|pllc|pc|p\.c\.|pa|p\.a\.|llp|apc)\b/ig," ")
      .replace(/^[\s,:;|\-–—]+|[\s,:;|\-–—]+$/g,"")
      .replace(/\s+/g," ").trim();
    const parts=cleaned.split(/\s+/).filter(Boolean);
    if(parts.length<2||parts.length>5)return;
    if(parts.some(x=>/\d|@|https?|www\./i.test(x)))return;
    if(!parts.every(x=>/^[A-Za-z.'’\-]+$/.test(x)))return;
    if(/\b(group|associates|partners|legal|services|office|firm)\b/i.test(cleaned))return;
    values.push(cleaned);
  };

  // Directory-first discovery knows the actual roster. Feed those verified
  // attorney identities into state-bar/public-record email lookup instead of
  // trying to reverse-engineer people from a generic firm name.
  const rosterNames=[
    ...(Array.isArray(lead.directory_attorney_names)?lead.directory_attorney_names:[]),
    ...(Array.isArray(lead.attorney_names)?lead.attorney_names:[])
  ];
  for(const candidate of rosterNames.slice(0,10))addPerson(candidate);
  const primary=likelyAttorneyName(lead);
  if(primary)addPerson(primary);

  // Google Maps frequently appends an attorney after the firm label:
  // "Firm Name: Jane Doe", "Firm Name | Jane Doe", or "Firm - Jane Doe".
  const suffixMatch=raw.match(/(?:[:|]|\s[-–—]\s)\s*([A-Z][A-Za-z.'’\-]+(?:\s+[A-Z][A-Za-z.'’\-]+){1,4})\s*$/);
  if(suffixMatch?.[1])addPerson(suffixMatch[1]);

  // Two named attorneys are often embedded directly in the Maps business name.
  // Capture both before a trailing "Attorneys..." label.
  const pair=raw.match(/^([A-Z][A-Za-z.'’\-]+(?:\s+[A-Z][A-Za-z.'’\-]+){1,3})\s+(?:&|and)\s+([A-Z][A-Za-z.'’\-]+(?:\s+[A-Z][A-Za-z.'’\-]+){1,3})\s*,?\s*(?:Attorneys?|Lawyers?|Counselors?)/i);
  if(pair){addPerson(pair[1]);addPerson(pair[2]);}

  // "Law Office(s) of Jane Doe" remains a strong person identity even when the
  // whole business label was classified as firm-shaped.
  const officeOf=raw.match(/law offices? of\s+([A-Z][A-Za-z.'’\-]+(?:\s+[A-Z][A-Za-z.'’\-]+){1,4})/i);
  if(officeOf?.[1])addPerson(officeOf[1]);

  const expanded=[];
  const suffixes=new Set(["jr","sr","ii","iii","iv","esq"]);
  for(const value of values){
    expanded.push(value);
    const parts=value.replace(/,/g," ").split(/\s+/).filter(Boolean);
    if(parts.length>=2&&parts.length<=4){
      const clean=parts.filter(x=>!suffixes.has(x.toLowerCase().replace(/\./g,"")));
      if(clean.length>=2){
        // Maps frequently stores attorneys as "Last First M". Search both forms.
        expanded.push([clean[1],...clean.slice(2),clean[0]].join(" "));
        expanded.push([clean[clean.length-1],...clean.slice(1,-1),clean[0]].join(" "));
      }
    }
  }
  return [...new Set(expanded.map(x=>x.replace(/\s+/g," ").trim()).filter(x=>x.split(/\s+/).length>=2))].slice(0,6);
}
async function zeroCostEmailFallback(lead={}){
  const names=attorneyNameVariants(lead).slice(0,3);
  if(!names.length)return {emails:[],source:"",name_variant:""};
  const primaryPublicSource=[
    lead.attorney_count_source,
    lead.law_directory_seed_source,
    lead.google_maps_url,
    lead.maps_url
  ].map(x=>String(x||"").trim()).find(x=>/^https?:\/\//i.test(x))||"";
  const attempts=await Promise.allSettled(names.map(async personName=>{
    const result=await withDeadline(
      enrichProfessionalEmail("recover-law-email-v6-public-source",{
        person_name:personName,
        company_name:String(lead.name||lead.title||personName),
        mode:"fast",
        real_only:true,
        use_case:"cold_outreach",
        hints:{source_urls:primaryPublicSource?[primaryPublicSource]:[]}
      }),
      20000,
      "email-enrich:"+personName
    );
    const published=(result?.evidence?.found_public_emails||[])
      .map(x=>String(x||"").trim().toLowerCase())
      .filter(x=>emailIdentityStrong(x,lead));
    const candidate=(result?.candidates||[])
      .map(x=>({email:String(x?.email||"").trim().toLowerCase(),confidence:Number(x?.confidence||0)}))
      .filter(x=>x.email&&published.includes(x.email)&&x.confidence>=0.9)
      .sort((a,b)=>b.confidence-a.confidence)[0];
    const best=String(result?.best_email||"").trim().toLowerCase();
    // email-enrich keeps its generic name-affinity contract. For this pipeline,
    // evidence.found_public_emails can still be used when our stronger
    // firm/person identity guard accepted the address; exact-source binding and
    // MX verification still run before strict eligibility.
    const accepted=candidate?[candidate.email]:
      (best&&published.includes(best)&&Number(result?.confidence||0)>=0.9?[best]:(published[0]?[published[0]]:[]));
    return {emails:accepted,source:String(result?.evidence?.sources_checked?.[0]||primaryPublicSource||""),name_variant:personName};
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
  const raw=String(text||"");
  const digits=raw.replace(/\D/g,"");
  const phone=String(lead.phone||"").replace(/\D/g,"").slice(-10);

  // CalBar sometimes strips or moves the visible "License Status" label in
  // anti-scrape/Jina renderings even though the same profile still contains the
  // exact published office phone. Exact 10-digit phone equality on a canonical
  // CalBar licensee URL is stronger identity evidence than a fragile layout
  // label, so accept that match before requiring the status parser. This does
  // NOT loosen email eligibility: the address still has to be published on this
  // exact profile, survive the CalBar decoy filter, MX, and no-owned-site gate.
  if(phone&&digits.includes(phone)){
    void redis.hIncrBy(STATS,"calbar_exact_phone_identity_accept",1).catch(()=>{});
    return true;
  }

  if(!calBarProfileStatusActive(raw)&&!isActiveCalBarProfile(sourceUrl))return false;
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
  if(rank<=4||rank>=90||knownThirdPartyDirectoryHost(url))return "";
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
  const legalContext=/\b(?:attorney|attorneys|lawyer|lawyers|law firm|law office|law offices|legal services|practice areas?|litigation|counsel)\b/i.test(String(text||""));
  // Common surnames/business words can collide with unrelated plumbers, schools,
  // retailers, stylists, etc. Unknown/alias domains now require clear legal
  // content in addition to exact identity evidence before they count as owned.
  if(exactFirmName&&phoneMatch&&legalContext)return "https://"+host;
  if(domainAffinity&&identityTokens&&phoneMatch&&legalContext)return "https://"+host;
  if(domainAffinity&&identityTokens&&geoMatch&&legalContext)return "https://"+host;
  return "";
}
function knownThirdPartyDirectoryHost(url=""){
  const host=hostOf(url);
  return /(?:^|\.)(?:reachattorneys\.com|lawyer\.com|lawyers\.com|martindale\.com|avvo\.com|justia\.com|findlaw\.com|superlawyers\.com|attorneydir\.com|lawyer-map\.com|lawyerdb\.org|attorneyslisted\.com|lawinfo\.com|hg\.org|411\.info|allbiz\.com|chamberofcommerce\.com|manta\.com|bbb\.org|yellowpages\.com|yelp\.com|birdeye\.com|mapquest\.com)$/i.test(host);
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

function extractConcatenatedCalBarEmails(text=""){
  // CalBar intentionally renders the Email field as a delimiter-free chain of
  // decoy addresses surrounding the real published mailbox. A generic email
  // regex therefore swallows the beginning of the next decoy into the previous
  // TLD (for example: real@firm.comdecoy@x.gov). Split on the next local-part@
  // boundary so each published candidate is recovered before identity scoring.
  const raw=normalizePublishedEmailText(text);
  const fieldMatch=raw.match(/\bEmail\s*:\s*([\s\S]{1,7000}?)(?=\|\s*Website\s*:|\bWebsite\s*:|$)/i);
  const field=String(fieldMatch?.[1]||"").trim();
  if(!field||!field.includes("@"))return [];
  const pattern=/([A-Z0-9._%+-]{1,96})@([A-Z0-9.-]+?\.[A-Z]{2,24}?)(?=[A-Z0-9._%+-]{1,96}@|\s|\||$)/ig;
  const out=[];
  for(const m of field.matchAll(pattern)){
    const email=String((m[1]||"")+"@"+(m[2]||"")).toLowerCase().replace(/[),.;:]+$/,"");
    if(isUsableLawEmail(email)&&!isThirdPartyEmailDomain(email))out.push(email);
  }
  return [...new Set(out)].slice(0,40);
}

function contextualEmails(text="",lead={},sourceUrl=""){
  const raw=normalizePublishedEmailText(text),out=[];
  const re=/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
  const isCalBar=/apps\.calbar\.ca\.gov$/i.test(hostOf(sourceUrl));
  let all;
  if(isCalBar){
    const separated=extractConcatenatedCalBarEmails(raw);
    all=separated.map(email=>{
      const index=raw.toLowerCase().indexOf(email.toLowerCase());
      return {email,index:index>=0?index:0};
    });
  }else{
    all=[...raw.matchAll(re)]
      .map(m=>({email:String(m[0]||"").toLowerCase().replace(/[),.;:]+$/,""),index:m.index||0}))
      .filter(x=>isUsableLawEmail(x.email)&&!isThirdPartyEmailDomain(x.email));
  }
  if(isCalBar){
    const before=all.length;
    all=all.filter(x=>calBarEmailCandidateStrong(x.email,lead));
    if(before>all.length)void redis.hIncrBy(STATS,"calbar_decoy_email_reject",before-all.length).catch(()=>{});
    if(all.length)void redis.hIncrBy(STATS,"calbar_delimiter_chain_recovered",all.length).catch(()=>{});
  }
  const uniqueAll=[...new Set(all.map(x=>x.email))];
  const fullPageMatch=pageMatchesLead(raw,lead,sourceUrl);
  const fullPhoneMatch=contextHasExactPhone(raw,lead);
  const trustedSource=trustedLawSource(sourceUrl,lead);

  // On an identity-matched official bar/court profile, the exact office phone
  // plus a published non-directory email is strong source binding even when the
  // mailbox is free-mail or the firm's domain is an acronym. This recovers
  // legitimate profile emails that the generic local-part heuristic rejected.
  if(trustedSource&&fullPageMatch&&fullPhoneMatch&&uniqueAll.length<=3){
    const sourceHost=hostOf(sourceUrl);
    const expectedHost=expectedBarHost(lead);
    const trustedProfileEmails=uniqueAll.filter(email=>{
      const domain=String(email).split("@")[1]?.toLowerCase()||"";
      if(!domain)return false;
      if(sourceHost&&(domain===sourceHost||sourceHost.endsWith("."+domain)||domain.endsWith("."+sourceHost)))return false;
      if(expectedHost&&(domain===expectedHost||domain.endsWith("."+expectedHost)))return false;
      return true;
    });
    if(trustedProfileEmails.length){
      void redis.hIncrBy(STATS,"official_profile_phone_email_accept",1).catch(()=>{});
      console.log(JSON.stringify({
        event:"law_official_profile_phone_email_accept",
        name:String(lead.name||lead.title||""),
        source:String(sourceUrl||""),
        emails:trustedProfileEmails.slice(0,4)
      }));
      return trustedProfileEmails.slice(0,8);
    }
  }

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
    const start=Math.max(0,m.index-1800),end=Math.min(raw.length,m.index+m.email.length+1800);
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
function directoryRosterNames(html="",source="",lead={}){
  const host=hostOf(source);
  if(!(/(^|\.)(?:lawyers|martindale|lawyer|findlaw)\.com$/i.test(host)||/^(?:lawyers\.)?law\.cornell\.edu$/i.test(host)||/^lawyers\.oyez\.org$/i.test(host)||/^lawyers\.lawyerlegion\.com$/i.test(host)))return [];
  const names=[];
  const seen=new Set();
  for(const m of String(html||"").matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{1,180}?)<\/a>/gi)){
    const href=String(m[1]||"");
    const label=stripHtml(String(m[2]||"")).replace(/\s+/g," ").trim();
    if(!label||label.length>90)continue;
    if(!/(?:attorney|lawyer|profile|people|professional)/i.test(href))continue;
    const cleaned=label.replace(/\b(?:esq(?:uire)?|attorney|lawyer|partner|associate|counsel)\b\.?/ig," ").replace(/\s+/g," ").trim();
    const parts=cleaned.split(/\s+/).filter(Boolean);
    if(parts.length<2||parts.length>5)continue;
    if(parts.some(x=>/\d|@|https?|www\./i.test(x)))continue;
    if(!parts.every(x=>/^[A-Za-z.'’\-]+$/.test(x)))continue;
    const key=normalize(cleaned);
    if(!key||seen.has(key))continue;
    seen.add(key); names.push(cleaned);
    if(names.length>10)break;
  }
  return names;
}
function directoryRosterCount(html="",source="",lead={}){
  const names=directoryRosterNames(html,source,lead);
  // On an identity-matched dedicated firm directory page, one unique attorney
  // is positive solo evidence, not "unknown". Returning 1 lets the strict 2-10
  // gate reject it instead of keeping it forever as an unresolved candidate.
  return names.length>10?11:names.length;
}

function strictFirmPageRosterNames(html="",source="",lead={}){
  const raw=String(html||"");
  if(!raw)return [];
  const phone=String(lead.phone||"").replace(/\D/g,"").slice(-10);
  if(!phone||!raw.replace(/\D/g,"").includes(phone))return [];
  if(!strictDirectoryFirmIdentity(raw,source,lead))return [];

  // Keep only the firm's explicit attorney/team section so nearby/recommended
  // attorneys never become email-search identities.
  const heading=/<h([2-4])\b[^>]*>\s*(?:<[^>]+>\s*)*(?:attorneys?|lawyers?|our\s+team|professionals?|people)(?:\s*<[^>]+>)*\s*<\/h\1>/ig;
  let best=[],m;
  while((m=heading.exec(raw))){
    const level=m[1];
    const start=m.index+m[0].length;
    const tail=raw.slice(start,start+120000);
    const next=new RegExp("<h"+level+"\\b","i").exec(tail);
    const section=next?tail.slice(0,next.index):tail.slice(0,50000);
    const names=directoryRosterNames(section,source,lead);
    if(names.length>best.length)best=names;
    if(best.length>10)break;
  }
  return best.slice(0,11);
}
function strictFirmPageRosterCount(html="",source="",lead={}){
  const names=strictFirmPageRosterNames(html,source,lead);
  return names.length>10?11:names.length;
}

function strictLawyerComRosterCount(html="",source="",lead={}){
  if(!/(^|\.)lawyer\.com$/i.test(hostOf(source)))return 0;
  const raw=String(html||"");
  if(!raw||!strictLawyerComIdentityMatch(source,stripHtml(raw).slice(0,70000),lead))return 0;

  // Count only the firm's dedicated Lawyers section. Never count Reviews,
  // recommendations, nearby attorneys, footer profiles, or other page modules.
  const heading=/<h([2-4])\b[^>]*>\s*(?:<[^>]+>\s*)*Lawyers(?:\s*<[^>]+>)*\s*<\/h\1>/i.exec(raw);
  if(!heading)return 0;
  const start=(heading.index||0)+heading[0].length;
  const tail=raw.slice(start,start+90000);
  const next=/<h[2-4]\b[^>]*>\s*(?:<[^>]+>\s*)*(?:Reviews?|Contact|About|Similar|Nearby|Location|Office|Services?)/i.exec(tail);
  const section=next?tail.slice(0,next.index):tail.slice(0,45000);
  return directoryRosterCount(section,source,lead);
}

function officialFirmSizeEstimate(text=""){
  const plain=String(text||"").replace(/\s+/g," ").trim();
  if(!plain)return 0;
  const range=plain.match(/\b(?:firm|office)\s+size\s*:?\s*(\d{1,2})\s*(?:to|[-–])\s*(\d{1,2})\b/i);
  if(range){
    const lo=Number(range[1]),hi=Number(range[2]);
    if(lo>0&&hi>=lo&&hi<=100)return lo>=2?hi:1;
  }
  const exact=plain.match(/\b(?:firm|office)\s+size\s*:?\s*(\d{1,3})\b/i);
  if(exact){
    const n=Number(exact[1]);
    if(n>0&&n<=500)return n;
  }
  // Lawyers.com/Martindale wording on dedicated firm pages:
  // "At this office location, there are 2 lawyers" / "there is 1 lawyer".
  const officeLocation=plain.match(/\bat\s+this\s+office\s+location\s*,?\s+there\s+(?:are|is)\s+(\d{1,3})\s+(?:lawyers?|attorneys?)\b/i);
  if(officeLocation){
    const n=Number(officeLocation[1]);
    if(n>0&&n<=500)return n;
  }
  const officeWith=plain.match(/\b(?:law\s+office|law\s+firm|office|firm)\s+with\s+(\d{1,3})\s+(?:lawyers?|attorneys?)\b/i);
  if(officeWith){
    const n=Number(officeWith[1]);
    if(n>0&&n<=500)return n;
  }
  const meetTeam=plain.match(/\bmeet\s+(?:all\s+)?(\d{1,3})\s+(?:lawyers?|attorneys?)\b/i);
  if(meetTeam){
    const n=Number(meetTeam[1]);
    if(n>0&&n<=500)return n;
  }
  if(/\b(?:firm|office)\s+size\s*:?\s*(?:solo|sole\s+practi(?:tioner|oner))\b/i.test(plain))return 1;
  return 0;
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
  const original=String(lead.name||lead.title||"")
    .replace(/\b(?:esq(?:uire)?|attorney\s+at\s+law)\b\.?/ig," ")
    .trim();
  if(!original)return [];

  const slugify=value=>String(value||"")
    .replace(/\s*&\s*/g," and ")
    .replace(/[^a-z0-9]+/gi," ")
    .trim().toLowerCase().replace(/\s+/g,"-");

  const fullSlug=slugify(original);
  const noSuffix=original
    .replace(/\b(?:llc|pllc|pc|apc|llp|pa)\b\.?/ig," ")
    .replace(/\b(?:p\s*\.\s*c|p\s*\.\s*a|l\s*\.\s*l\s*\.\s*c)\b\.?/ig," ");
  const baseSlug=slugify(noSuffix);
  const stripped=baseSlug
    .replace(/^the-/,"")
    .replace(/^law-offices?-of-/,"")
    .replace(/^law-firm-of-/,"");
  const state=normalizedStateCode(lead).toLowerCase();

  return [...new Set([
    `https://www.lawyer.com/firm/${fullSlug}.html`,
    ...(state?[`https://www.lawyer.com/firm/${fullSlug}-${state}.html`]:[]),
    `https://www.lawyer.com/firm/${baseSlug}.html`,
    ...(state?[`https://www.lawyer.com/firm/${baseSlug}-${state}.html`]:[]),
    `https://www.lawyer.com/firm/law-offices-of-${stripped}.html`,
    `https://www.lawyer.com/firm/law-office-of-${stripped}${state?"-"+state:""}.html`
  ])].filter(url=>!/\/firm\/\.html$/i.test(url)).slice(0,6);
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

function likelyOwnedDomainCandidates(lead={}){
  const raw=normalize(String(lead.name||lead.title||""));
  const stop=new Set(["the","law","legal","firm","firms","office","offices","attorney","attorneys","lawyer","lawyers","group","pllc","llc","pc","pa","p","c","professional","corporation","associates","association","at"]);
  const tokens=raw.split(" ").filter(t=>t.length>=3&&!stop.has(t)).slice(0,4);
  if(!tokens.length)return [];
  const joined=tokens.join("");
  const first=tokens[0]||"";
  const firstTwo=tokens.slice(0,2).join("");
  const values=[
    joined,
    firstTwo,
    first,
    joined+"law",
    firstTwo+"law",
    first+"law",
    joined+"legal",
    firstTwo+"legal"
  ].filter(x=>x.length>=4);
  return [...new Set(values.map(x=>"https://"+x+".com"))].slice(0,8);
}

async function probeLikelyOwnedDomains(lead={},key=""){
  const candidates=likelyOwnedDomainCandidates(lead).slice(0,6);
  if(!candidates.length)return "";
  // Guessed domains are cheap candidates, so probe them with bounded direct HTTP
  // rather than the heavy research stack. This keeps send-ready audits below the
  // enrich job timeout and avoids orphaned Promise.race work mutating Redis later.
  const checks=await Promise.allSettled(candidates.map(async url=>{
    try{
      const page=await fetchText(url,4500);
      if(!page?.html)return "";
      const finalUrl=String(page.final_url||url);
      const text=stripHtml(page.html).slice(0,36000);
      const phone=String(lead.phone||"").replace(/\D/g,"").slice(-10);
      const phoneMatch=Boolean(phone&&String(text).replace(/\D/g,"").includes(phone));
      if(!pageMatchesLead(text,lead,finalUrl)&&!phoneMatch)return "";
      return ownedWebsiteFromMatchedPage(finalUrl,text,lead)||new URL(finalUrl).origin;
    }catch{return "";}
  }));
  for(const item of checks){
    if(item.status==="fulfilled"&&item.value){
      await redis.hIncrBy(STATS,"likely_owned_domain_probe_hit",1);
      console.log(JSON.stringify({event:"law_likely_owned_domain_hit",key,name:String(lead.name||lead.title||""),website:item.value}));
      return item.value;
    }
  }
  await redis.hIncrBy(STATS,"likely_owned_domain_probe_miss",1);
  return "";
}

function directoryAttorneyIdentity(html="",lead={}){
  const raw=String(html||"");
  const h1=stripHtml(String(raw.match(/<h1\b[^>]*>([\s\S]{1,320}?)<\/h1>/i)?.[1]||""));
  const title=stripHtml(String(raw.match(/<title\b[^>]*>([\s\S]{1,320}?)<\/title>/i)?.[1]||""));
  const candidates=[h1,title].map(value=>String(value||"")
    .replace(/\b(?:attorney|lawyer|profile|find a lawyer|law firm|law office|law offices|esq(?:uire)?|partner|associate|counsel)\b/ig," ")
    .replace(/[|–—-].*$/," ")
    .replace(/\s+/g," ").trim());
  const firmTokens=leadNameTokens(lead).map(x=>normalize(x)).filter(x=>x.length>=3);
  for(const candidate of candidates){
    const parts=candidate.split(/\s+/).filter(Boolean);
    if(parts.length<2||parts.length>5)continue;
    if(parts.some(x=>/\d|@|https?|www\./i.test(x)))continue;
    if(!parts.every(x=>/^[A-Za-z.'’\-]+$/.test(x)))continue;
    const norm=normalize(candidate);
    if(!firmTokens.some(t=>norm.includes(t)))continue;
    return norm;
  }
  return "";
}

function strictDirectoryFirmIdentity(html="",source="",lead={}){
  const raw=String(html||"");
  const h1=stripHtml(String(raw.match(/<h1\b[^>]*>([\s\S]{1,320}?)<\/h1>/i)?.[1]||""));
  const title=stripHtml(String(raw.match(/<title\b[^>]*>([\s\S]{1,320}?)<\/title>/i)?.[1]||""));
  const identity=normalize((h1+" "+title).trim());
  if(!identity)return false;

  const phone=String(lead.phone||"").replace(/\D/g,"").slice(-10);
  const phoneMatch=Boolean(phone&&raw.replace(/\D/g,"").includes(phone));
  const fullName=normalize(lead.name||lead.title||"");
  const tokens=leadNameTokens(lead).filter(x=>x.length>=4);
  const hits=tokens.filter(t=>identity.includes(t)).length;
  const exactName=Boolean(fullName.length>=8&&identity.includes(fullName));

  // A generic directory page may mention many nearby firms in body text.
  // Accept headcount only when the page's own H1/title identifies this firm,
  // with phone as corroboration for short/ambiguous names.
  if(exactName)return true;
  if(tokens.length>=2&&hits>=Math.min(2,tokens.length))return true;
  if(tokens.length===1&&hits===1&&phoneMatch)return true;
  return false;
}


function bingResultRecords(html=""){
  const out=[];
  const raw=String(html||"");
  for(const m of raw.matchAll(/<li\b[^>]*class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi)){
    const block=String(m[1]||"");
    let url="";
    const href=block.match(/<a\b[^>]*href=["']([^"']+)["']/i)?.[1]||"";
    if(href)url=decodeBingRedirect(href)||String(href).replace(/&amp;/g,"&");
    if(!/^https?:\/\//i.test(url))continue;
    out.push({url,text:stripHtml(block).slice(0,5000)});
  }
  return out.slice(0,12);
}

function bingRssResultRecords(xml=""){
  const out=[];
  for(const m of String(xml||"").matchAll(/<item>([\s\S]*?)<\/item>/gi)){
    const block=String(m[1]||"");
    const url=String(block.match(/<link>(https?:\/\/[^<]+)<\/link>/i)?.[1]||"").replace(/&amp;/g,"&");
    if(!url)continue;
    const title=String(block.match(/<title>([\s\S]*?)<\/title>/i)?.[1]||"");
    const desc=String(block.match(/<description>([\s\S]*?)<\/description>/i)?.[1]||"");
    out.push({url,text:stripHtml(title+" "+desc).slice(0,5000)});
  }
  return out.slice(0,12);
}

function duckResultRecords(html=""){
  const out=[];
  const raw=String(html||"");
  for(const m of raw.matchAll(/<div\b[^>]*class=["'][^"']*\bresult\b[^"']*["'][^>]*>([\s\S]*?)(?=<div\b[^>]*class=["'][^"']*\bresult\b|$)/gi)){
    const block=String(m[1]||"");
    const href=String(block.match(/<a\b[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["']/i)?.[1]||"");
    if(!href)continue;
    let url="";
    try{
      const u=new URL(href.replace(/&amp;/g,"&"),"https://html.duckduckgo.com");
      const uddg=u.searchParams.get("uddg");
      url=uddg?decodeURIComponent(uddg):u.href;
    }catch{url=href;}
    if(!/^https?:\/\//i.test(url))continue;
    out.push({url,text:stripHtml(block).slice(0,5000)});
  }
  return out.slice(0,12);
}

function indexedDirectoryHeadcountEvidence(records=[],lead={}){
  const phone=normalizeLawPhone(lead.phone);
  const fullName=normalize(lead.name||lead.title||"");
  const city=normalize(normalizedLeadCity(lead));
  const state=normalize(normalizedStateCode(lead)||lead.region||lead.state||"");
  const allowed=["lawyers.com","martindale.com","findlaw.com","lawyer.com","justia.com","lawyers.law.cornell.edu","lawyers.oyez.org","lawyers.lawyerlegion.com"];
  for(const record of records||[]){
    const source=String(record?.url||"");
    const host=hostOf(source);
    if(!allowed.some(h=>host===h||host.endsWith("."+h)))continue;
    const text=String(record?.text||"").slice(0,6000);
    if(!text)continue;
    const norm=normalize(text);
    const phoneMatch=Boolean(phone&&text.replace(/\D/g,"").includes(phone));
    const nameMatch=Boolean(fullName.length>=8&&norm.includes(fullName));
    const geoMatch=Boolean((city&&norm.includes(city))||(state&&(" "+norm+" ").includes(" "+state+" ")));
    if(!phoneMatch&&!(nameMatch&&geoMatch))continue;
    const count=officialFirmSizeEstimate(text);
    if(!(count>0))continue;
    return {count,source,indexed:true,text:text.slice(0,900)};
  }
  return null;
}

async function directDirectorySizeEvidence(lead={},key=""){
  const name=String(lead.name||lead.title||"").replace(/"/g,"").trim();
  if(!name)return {count:0,source:"",website:""};
  const phone=String(lead.phone||"").replace(/\D/g,"").slice(-10);
  const phonePretty=phone.length===10?phone.slice(0,3)+"-"+phone.slice(3,6)+"-"+phone.slice(6):"";
  const city=normalizedLeadCity(lead);
  const state=normalizedStateCode(lead)||String(lead.region||lead.state||"").trim();
  const hosts=["lawyers.com","martindale.com","findlaw.com","lawyer.com","justia.com","lawyers.law.cornell.edu","lawyers.oyez.org","lawyers.lawyerlegion.com"];

  // Two broad exact-identity searches replace the old 14-query sequential loop.
  // They surface the same public directories while keeping one lead bounded to
  // a handful of network calls, which is required for a 10k calling pipeline.
  const queries=[...new Set([
    ...(phonePretty?[
      `"${phonePretty}" "firm size"`,
      `site:lawyers.com "${phonePretty}" "Law Office with"`
    ]:[]),
    `site:lawyers.com "${name}" "${city}" "${state}" "Law Office with" lawyers`.trim(),
    `site:lawyer.com/firm "${name}" "Firm Size"`.trim(),
    `site:martindale.com "${name}" "Firm Size"`.trim(),
    `site:findlaw.com "${name}" "${city}" "${state}" attorneys`.trim()
  ].filter(Boolean))].slice(0,6);

  const searchResults=await Promise.allSettled(queries.map(async query=>{
    const [htmlResult,rssResult,duckResult,googleResult]=await Promise.allSettled([
      fetchText("https://www.bing.com/search?q="+encodeURIComponent(query),3800),
      fetchText("https://www.bing.com/search?format=rss&q="+encodeURIComponent(query),3800),
      fetchText("https://html.duckduckgo.com/html/?q="+encodeURIComponent(query),3800),
      fetchText("https://www.google.com/search?num=10&hl=en&q="+encodeURIComponent(query),4200)
    ]);
    const html=htmlResult.status==="fulfilled"?String(htmlResult.value?.html||""):"";
    const rss=rssResult.status==="fulfilled"?String(rssResult.value?.html||""):"";
    const duck=duckResult.status==="fulfilled"?String(duckResult.value?.html||""):"";
    const google=googleResult.status==="fulfilled"?String(googleResult.value?.html||""):"";
    return {
      links:[...new Set([
        ...bingResultLinks(html),...bingRssResultLinks(rss),
        ...duckResultLinks(duck),...markdownResultLinks(duck),...googleResultLinks(google)
      ])],
      records:[...bingResultRecords(html),...bingRssResultRecords(rss),...duckResultRecords(duck)]
    };
  }));

  const indexedRecords=[];
  for(const result of searchResults){
    if(result.status!=="fulfilled")continue;
    indexedRecords.push(...(result.value?.records||[]));
  }
  // Search-result snippets are discovery hints only. They can mix the query,
  // neighbouring results, or stale snippets with a different firm's URL. The
  // old path accepted those snippets as final headcount evidence and falsely
  // classified many multi-attorney firms as solos. Keep the hint for
  // diagnostics, but only a fetched identity-matched source page may verify size.
  const indexedEvidence=indexedDirectoryHeadcountEvidence(indexedRecords,lead);
  if(indexedEvidence){
    await redis.hIncrBy(STATS,"indexed_directory_hint_ignored",1);
    console.log(JSON.stringify({
      event:"law_indexed_directory_hint_ignored",key,name,count:indexedEvidence.count,
      source:indexedEvidence.source
    }));
  }
  if(INDEXED_HEADCOUNT_DIAGNOSTICS<8&&indexedRecords.length){
    INDEXED_HEADCOUNT_DIAGNOSTICS++;
    const legalRecords=indexedRecords.filter(r=>{
      const h=hostOf(r.url);
      return hosts.some(x=>h===x||h.endsWith("."+x));
    });
    console.log(JSON.stringify({
      event:"law_indexed_directory_diagnostic",key,name,phone:phonePretty,city,state,
      totalRecords:indexedRecords.length,legalRecords:legalRecords.length,
      records:legalRecords.slice(0,5).map(r=>({url:r.url,text:String(r.text||"").slice(0,900)}))
    }));
  }

  const resultPages=[];
  for(const result of searchResults){
    if(result.status!=="fulfilled")continue;
    for(const url of result.value?.links||[]){
      const host=hostOf(url);
      if(!hosts.some(h=>host===h||host.endsWith("."+h)))continue;
      if(!resultPages.includes(url))resultPages.push(url);
      if(resultPages.length>=14)break;
    }
    if(resultPages.length>=14)break;
  }

  const pages=await Promise.allSettled(resultPages.slice(0,14).map(async url=>{
    try{
      const page=await fetchResearchPage(url,{...lead,conversion_headcount_priority:true},key,true);
      if(!page?.html)return null;
      const source=String(page.final_url||url);
      const text=stripHtml(page.html).slice(0,70000);
      const host=hostOf(source);
      const firmIdentityMatch=strictDirectoryFirmIdentity(page.html,source,lead);
      const phoneMatch=Boolean(phone&&String(text).replace(/\D/g,"").includes(phone));
      const normText=normalize(text);
      const cityMatch=Boolean(city&&normText.includes(normalize(city)));
      const profileIdentity=(phoneMatch&&cityMatch)?directoryAttorneyIdentity(page.html,lead):"";
      if(!firmIdentityMatch&&!profileIdentity)return null;

      // Prefer explicit Firm Size, otherwise count unique attorney profile
      // links only inside the dedicated firm's Attorneys/Team section.
      const explicitCount=firmIdentityMatch?officialFirmSizeEstimate(text):0;
      const firmRosterCount=firmIdentityMatch?strictFirmPageRosterCount(page.html,source,lead):0;
      const count=explicitCount>0?explicitCount:firmRosterCount;
      let website="";
      if(firmIdentityMatch){
        const websiteCandidate=outboundFirmWebsiteFromDirectory(page.html,lead);
        if(websiteCandidate)website=await verifyOwnedWebsiteCandidate(websiteCandidate,lead);
      }
      return {count,source,host,explicit:explicitCount>0,firmRoster:firmRosterCount>0,website,profileIdentity,phoneMatch,cityMatch};
    }catch{return null;}
  }));

  const pageValues=pages.filter(x=>x.status==="fulfilled"&&x.value).map(x=>x.value);
  const rosterByIdentity=new Map();
  for(const item of pageValues){
    if(item.profileIdentity&&!rosterByIdentity.has(item.profileIdentity))rosterByIdentity.set(item.profileIdentity,item);
  }
  const roster=[...rosterByIdentity.values()];
  const verifiedWebsite=pageValues.find(x=>x.website)?.website||"";
  if(roster.length>=2){
    const count=roster.length>10?11:roster.length;
    const source=roster[0].source;
    await redis.hIncrBy(STATS,"direct_directory_phone_roster_hit",1);
    console.log(JSON.stringify({
      event:"law_direct_directory_phone_roster_hit",key,name,count,source,
      identities:roster.slice(0,10).map(x=>x.profileIdentity),
      sources:roster.slice(0,10).map(x=>x.source)
    }));
    return {count,source,website:verifiedWebsite};
  }

  const evidence=pageValues.filter(x=>x.count>0);
  if(!evidence.length){
    await redis.hIncrBy(STATS,"direct_directory_size_miss",1);
    return {count:0,source:"",website:verifiedWebsite};
  }

  // Explicit 11+ evidence is disqualifying. Roster-derived 11 is only accepted
  // when two directory hosts agree; one directory can contain recommendations.
  const oversizedExplicit=evidence.filter(x=>x.count>10&&x.explicit).sort((a,b)=>b.count-a.count)[0];
  const oversizedHosts=new Set(evidence.filter(x=>x.count>10).map(x=>x.host));
  if(oversizedExplicit||oversizedHosts.size>=2){
    const chosen=oversizedExplicit||evidence.find(x=>x.count>10);
    await redis.hIncrBy(STATS,"direct_directory_size_hit",1);
    console.log(JSON.stringify({event:"law_direct_directory_size_hit",key,name,count:chosen.count,source:chosen.source,website:verifiedWebsite,evidence:evidence.slice(0,8)}));
    return {count:chosen.count,source:chosen.source,website:verifiedWebsite};
  }

  const target=evidence.filter(x=>x.count>=2&&x.count<=10)
    .sort((a,b)=>Number(b.explicit)-Number(a.explicit)||b.count-a.count)[0];
  if(target){
    await redis.hIncrBy(STATS,"direct_directory_size_hit",1);
    console.log(JSON.stringify({event:"law_direct_directory_size_hit",key,name,count:target.count,source:target.source,website:verifiedWebsite,evidence:evidence.slice(0,8)}));
    return {count:target.count,source:target.source,website:verifiedWebsite};
  }

  const solo=evidence.filter(x=>x.count===1);
  const explicitSolo=solo.find(x=>x.explicit);
  const soloHosts=new Set(solo.map(x=>x.host));
  if(explicitSolo||soloHosts.size>=2){
    const chosen=explicitSolo||solo[0];
    if(lawFirmNameShape(lead)==="multi"){
      await redis.hIncrBy(STATS,"direct_directory_solo_multi_conflict",1);
      return {count:0,source:"",website:verifiedWebsite};
    }
    await redis.hIncrBy(STATS,"direct_directory_size_solo_confirmed",1);
    return {count:1,source:chosen.source,website:verifiedWebsite};
  }

  await redis.hIncrBy(STATS,"direct_directory_size_ambiguous",1);
  return {count:0,source:"",website:verifiedWebsite};
}
async function directFloridaFirmRosterHeadcountEvidence(lead={},key=""){
  if(normalizedStateCode(lead)!=="FL")return {count:0,source:""};
  const rawFirm=String(lead.name||lead.title||"").replace(/["']/g," ").replace(/\s+/g," ").trim();
  if(rawFirm.length<4)return {count:0,source:""};
  const city=normalizedLeadCity(lead);
  const phone=String(lead.phone||"").replace(/\D/g,"").slice(-10);
  const variants=[...new Set([
    rawFirm,
    rawFirm.replace(/\b(?:attorneys?\s+at\s+law|law\s+offices?|law\s+firm|llc|pllc|p\.?a\.?|p\.?c\.?|llp|apc)\b/gi," ")
      .replace(/[,.;]+/g," ").replace(/\s+/g," ").trim()
  ].filter(x=>x.length>=4))].slice(0,2);

  for(const firm of variants){
    try{
      await redis.hIncrBy(STATS,"florida_firm_roster_attempt",1);
      const searchUrl="https://www.floridabar.org/directories/find-mbr/?lName=&lNameSdx=N&fName=&fNameSdx=N&eligible=N&deceased=N&firm="+
        encodeURIComponent(firm)+"&locValue="+encodeURIComponent(city)+"&locType=C&pracAreas=&lawSchool=&services=&langs=&certValue=&pageNumber=1&pageSize=20";
      const search=await fetchText(searchUrl,6000);
      const html=String(search?.html||"");
      const links=[];
      for(const m of html.matchAll(/href=["']([^"']*\/directories\/find-mbr\/profile\/\?[^"']*num=\d+[^"']*)["']/gi)){
        try{
          const href=new URL(String(m[1]||""),searchUrl).href.split("#")[0];
          if(!links.includes(href))links.push(href);
        }catch{}
      }
      if(!links.length)continue;

      const pages=await Promise.allSettled(links.slice(0,11).map(async url=>{
        const page=await fetchText(url,5000);
        const html=String(page?.html||"");
        const text=stripHtml(html).slice(0,60000);
        if(!text)return null;
        const norm=normalize(text);
        const digits=text.replace(/\D/g,"");
        const fullFirm=normalize(rawFirm);
        const firmTokens=leadNameTokens(lead).filter(t=>t.length>=4);
        const tokenHits=firmTokens.filter(t=>norm.includes(t)).length;
        const firmMatch=(fullFirm.length>=8&&norm.includes(fullFirm)) ||
          (firmTokens.length>=2&&tokenHits>=Math.min(2,firmTokens.length));
        const phoneMatch=Boolean(phone&&digits.includes(phone));
        return (phoneMatch||firmMatch)?{url,html,text}:null;
      }));
      const matchedRaw=pages.filter(x=>x.status==="fulfilled"&&x.value).map(x=>x.value);
      const matched=[...new Map(matchedRaw.map(x=>[x.url,x])).values()];
      if(matched.length){
        const count=matched.length>10?11:matched.length;
        const emailEvidence=[];
        for(const item of matched.slice(0,10)){
          for(const email of contextualEmails(item.html,lead,item.url)){
            emailEvidence.push({email,source:item.url});
          }
        }
        const checked=await Promise.all([...new Map(emailEvidence.map(x=>[x.email,x])).values()].slice(0,8).map(async x=>({
          ...x,ok:await hasMailExchange(x.email)
        })));
        const published=checked.filter(x=>x.ok);
        await redis.hIncrBy(STATS,"florida_firm_roster_hit",1);
        if(published.length)await redis.hIncrBy(STATS,"florida_firm_roster_email_hit",1);
        console.log(JSON.stringify({
          event:"law_florida_firm_roster_headcount_hit",key,name:rawFirm,
          count,firm,city,source:matched[0].url,
          publishedEmails:published.map(x=>x.email).slice(0,3)
        }));
        return {
          count,source:matched[0].url,
          publishedEmails:rankLawEmails(published.map(x=>x.email)).slice(0,5),
          emailSource:published[0]?.source||""
        };
      }
    }catch(error){
      await redis.hIncrBy(STATS,"florida_firm_roster_error",1);
    }
  }
  return {count:0,source:""};
}

async function phoneRosterHeadcountEvidence(lead={},key=""){
  const phone=String(lead.phone||"").replace(/\D/g,"").slice(-10);
  if(phone.length!==10)return {count:0,source:""};
  const phonePretty=phone.slice(0,3)+"-"+phone.slice(3,6)+"-"+phone.slice(6);
  const city=normalize(normalizedLeadCity(lead));
  const stateCode=String(normalizedStateCode(lead)||"").toLowerCase();
  const stateName=normalize(US_STATE_NAMES[String(normalizedStateCode(lead)||"").toUpperCase()]||"");
  const firmTokens=leadNameTokens(lead).filter(t=>t.length>=4);
  const officialHost=expectedBarHost(lead);
  await redis.hIncrBy(STATS,"phone_roster_headcount_attempt",1);

  // Official bar first. Then fall back to the four public legal directories.
  const hosts=[...new Set([
    ...(officialHost?[officialHost]:[]),
    "lawyers.com","martindale.com","findlaw.com","justia.com"
  ])];

  const tokenPresent=(text,token)=>{
    if(!token)return false;
    const padded=" "+normalize(text)+" ";
    return padded.includes(" "+normalize(token)+" ");
  };

  for(const host of hosts){
    const official=Boolean(officialHost&&(host===officialHost||host.endsWith("."+officialHost)));
    const queries=[
      'site:'+host+' "'+phonePretty+'" attorney',
      'site:'+host+' "'+phonePretty+'" lawyer'
    ];
    const searchResults=await Promise.allSettled(queries.map(async q=>{
      const [bingPage,rssPage,duckPage]=await Promise.allSettled([
        fetchText("https://www.bing.com/search?q="+encodeURIComponent(q),3800),
        fetchText("https://www.bing.com/search?format=rss&q="+encodeURIComponent(q),3800),
        fetchText("https://html.duckduckgo.com/html/?q="+encodeURIComponent(q),3800)
      ]);
      const bh=bingPage.status==="fulfilled"?String(bingPage.value?.html||""):"";
      const rh=rssPage.status==="fulfilled"?String(rssPage.value?.html||""):"";
      const dh=duckPage.status==="fulfilled"?String(duckPage.value?.html||""):"";
      return [...new Set([
        ...bingResultLinks(bh),...bingRssResultLinks(rh),
        ...duckResultLinks(dh),...markdownResultLinks(dh)
      ])].filter(url=>{
        const h=hostOf(url);
        return h===host||h.endsWith("."+host);
      });
    }));

    const links=[];
    for(const result of searchResults){
      if(result.status!=="fulfilled")continue;
      for(const url of result.value||[]){
        if(!links.includes(url))links.push(url);
        if(links.length>=(official?24:16))break;
      }
    }
    if(!links.length)continue;
    if(official)await redis.hIncrBy(STATS,"phone_roster_official_attempt",1);

    const pages=await Promise.allSettled(links.map(async url=>{
      try{
        const page=await fetchResearchPage(url,{...lead,conversion_headcount_priority:true},key,true);
        if(!page?.html)return null;
        const source=String(page.final_url||url);
        const text=stripHtml(page.html).slice(0,65000);
        if(!String(text).replace(/\D/g,"").includes(phone))return null;

        const norm=normalize(text);
        const cityMatch=Boolean(city&&norm.includes(city));
        // Do not use raw norm.includes("il") style checks: two-letter state
        // abbreviations collide with ordinary words and created false matches.
        const stateMatch=Boolean(
          (stateCode&&tokenPresent(norm,stateCode)) ||
          (stateName&&norm.includes(stateName))
        );
        const firmHits=firmTokens.filter(t=>norm.includes(t)).length;
        const firmMatch=firmTokens.length>0&&firmHits>=Math.min(2,firmTokens.length);

        // Exact office phone on the state's official bar profile is strong
        // identity evidence. Third-party directories need geo/firm corroboration.
        if(!official&&!cityMatch&&!stateMatch&&!firmMatch)return null;

        const raw=String(page.html);
        const h1=stripHtml(String(raw.match(/<h1\b[^>]*>([\s\S]{1,240}?)<\/h1>/i)?.[1]||""));
        const title=stripHtml(String(raw.match(/<title\b[^>]*>([\s\S]{1,240}?)<\/title>/i)?.[1]||""));
        let identity=(h1||title)
          .replace(/\b(?:attorney|lawyer|profile|law firm|law office|law offices|find a lawyer)\b/ig," ")
          .replace(/\s+/g," ").trim();

        let parts=identity.split(/\s+/).filter(Boolean);
        if(parts.length<2||parts.length>8||parts.some(x=>/\d|@|https?|www\./i.test(x))){
          try{
            const u=new URL(source);
            identity=decodeURIComponent(u.pathname.split("/").filter(Boolean).pop()||source)
              .replace(/[-_]+/g," ").replace(/\s+/g," ").trim();
          }catch{identity=source;}
          parts=identity.split(/\s+/).filter(Boolean);
        }
        const identityKey=normalize(identity)||normalize(source);
        return {source,identity:identityKey,official,html:String(page.html||"")};
      }catch{return null;}
    }));

    const matched=pages.filter(x=>x.status==="fulfilled"&&x.value).map(x=>x.value);
    const unique=[...new Map(matched.map(x=>[x.identity,x])).values()];
    if(unique.length>=2){
      const count=unique.length>10?11:unique.length;
      const emailEvidence=[];
      for(const item of unique.slice(0,10)){
        for(const email of contextualEmails(item.html||"",lead,item.source)){
          emailEvidence.push({email,source:item.source});
        }
      }
      const checked=await Promise.all([...new Map(emailEvidence.map(x=>[x.email,x])).values()].slice(0,8).map(async x=>({
        ...x,ok:await hasMailExchange(x.email)
      })));
      const published=checked.filter(x=>x.ok);
      await redis.hIncrBy(STATS,"phone_roster_headcount_hit",1);
      if(official)await redis.hIncrBy(STATS,"phone_roster_official_hit",1);
      if(published.length)await redis.hIncrBy(STATS,"phone_roster_email_hit",1);
      console.log(JSON.stringify({
        event:"law_phone_roster_headcount_hit",key,name:String(lead.name||lead.title||""),
        count,phone:phonePretty,host,official,sources:unique.slice(0,10).map(x=>x.source),
        publishedEmails:published.map(x=>x.email).slice(0,3)
      }));
      return {
        count,source:unique[0].source,
        publishedEmails:rankLawEmails(published.map(x=>x.email)).slice(0,5),
        emailSource:published[0]?.source||""
      };
    }
  }

  await redis.hIncrBy(STATS,"phone_roster_headcount_miss",1);
  return {count:0,source:""};
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
    if(!strictDirectoryFirmIdentity(page.html,source,lead))continue;
    // Explicit firm size is preferred. Otherwise count only the dedicated
    // Lawyers section on this exact identity-matched firm page.
    const explicitCount=officialFirmSizeEstimate(text);
    const rosterCount=explicitCount>0?0:strictLawyerComRosterCount(page.html,source,lead);
    const count=explicitCount>0?explicitCount:rosterCount;
    if(count>0){
      // A third-party "Firm Size: 1" conflicts with an explicit multi-attorney
      // business name often enough that it must not terminate strict research.
      // Keep looking for another directory/official roster; positive 2-10 or
      // oversized evidence remains usable immediately.
      if(count===1&&lawFirmNameShape(lead)==="multi"){
        await redis.hIncrBy(STATS,"direct_lawyercom_solo_multi_conflict",1);
        console.log(JSON.stringify({event:"law_direct_lawyercom_solo_multi_conflict",key,name:String(lead.name||lead.title||""),source}));
        continue;
      }
      await redis.hIncrBy(STATS,"direct_lawyercom_size_hit",1);
      console.log(JSON.stringify({event:"law_direct_lawyercom_size_hit",key,name:String(lead.name||lead.title||""),count,source}));
      // Always preserve the verified firm's attorney identities. Explicit
      // "Firm Size" evidence proves count, but suppressing the Lawyers roster
      // here starved later email discovery of the actual people to search for.
      const rosterNames=strictFirmPageRosterNames(page.html,source,lead);
      const profileEmails=contextualEmails(page.html,lead,source)
        .filter(email=>isUsableLawEmail(email)&&!isThirdPartyEmailDomain(email));
      const checkedEmails=await Promise.all([...new Set(profileEmails)].slice(0,6).map(async email=>({
        email,ok:await hasMailExchange(email)
      })));
      const publishedEmails=rankLawEmails(checkedEmails.filter(x=>x.ok).map(x=>x.email)).slice(0,5);
      if(publishedEmails.length)await redis.hIncrBy(STATS,"direct_lawyercom_email_hit",1);
      return {count,source,attorneyNames:rosterNames.slice(0,10),publishedEmails,emailSource:publishedEmails.length?source:""};
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
function googleResultLinks(html=""){
  const out=[];
  const raw=String(html||"").replace(/&amp;/g,"&");
  for(const m of raw.matchAll(/href=["'](?:\/url\?q=|https?:\/\/www\.google\.com\/url\?q=)(https?%3A%2F%2F[^"'&]+|https?:\/\/[^"'&]+)[^"']*["']/gi)){
    let value=String(m[1]||"");
    try{value=decodeURIComponent(value);}catch{}
    try{
      const u=new URL(value);
      if(/google\.com$/i.test(u.hostname))continue;
      if(!out.includes(u.href))out.push(u.href);
    }catch{}
  }
  // Modern Google often places the destination directly in href.
  for(const m of raw.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)){
    try{
      const u=new URL(String(m[1]||""));
      if(/(^|\.)google\.com$/i.test(u.hostname))continue;
      if(!out.includes(u.href))out.push(u.href);
    }catch{}
  }
  return out.slice(0,20);
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
  if(!force&&(!highValueLawResearchLead(lead)||lead.conversion_headcount_priority===true))return "";
  const name=String(lead.name||lead.title||"").replace(/"/g,"").trim();
  if(!name)return "";
  const phone=String(lead.phone||"").replace(/\D+/g,"").slice(-10);
  const city=normalizedLeadCity(lead);
  const region=normalizedStateCode(lead)||String(lead.region||lead.state||lead.state_code||lead.acquisition_location||"").trim();
  const person=likelyAttorneyName(lead);
  const queries=[...new Set([
    ...(phone?[`"${name}" "${phone}" website`]:[]),
    `"${name}" ${city} ${region} law firm website`.trim(),
    ...(person?[`"${person}" ${city} ${region} attorney website`.trim()]:[])
  ].filter(Boolean))].slice(0,3);
  const searchResults=await Promise.allSettled(queries.map(async q=>{
    const bingUrl="https://www.bing.com/search?q="+encodeURIComponent(q);
    const duckUrl="https://html.duckduckgo.com/html/?q="+encodeURIComponent(q);
    const [htmlResult,rssResult,duckResult]=await Promise.allSettled([
      fetchText(bingUrl,4200),
      fetchText("https://www.bing.com/search?format=rss&q="+encodeURIComponent(q),4200),
      fetchText(duckUrl,4200)
    ]);
    const html=htmlResult.status==="fulfilled"?htmlResult.value?.html||"":"";
    const rss=rssResult.status==="fulfilled"?rssResult.value?.html||"":"";
    const duck=duckResult.status==="fulfilled"?duckResult.value?.html||"":"";
    return [...new Set([
      ...bingResultLinks(html),
      ...bingRssResultLinks(rss),
      ...duckResultLinks(duck),
      ...markdownResultLinks(duck)
    ])];
  }));
  const links=[];
  for(const result of searchResults){
    if(result.status!=="fulfilled")continue;
    for(const url of result.value||[]){
      // Exact-name/phone search results can reveal an owned site whose domain
      // is a brand alias unrelated to the firm's Maps name (for example an
      // initials/advocates domain). Fetch unknown first-party candidates and
      // let ownedWebsiteFromMatchedPage enforce exact identity/phone evidence.
      const rank=lawSourceRank(url,lead);
      // Owned sites can be discovered either directly or through a public
      // directory page that explicitly links out to the firm's real website.
      if(rank!==6&&!knownThirdPartyDirectoryHost(url))continue;
      if(!links.includes(url))links.push(url);
      if(links.length>=16)break;
    }
  }
  const pages=await Promise.allSettled(links.slice(0,12).map(async url=>{
    try{return {url,page:await fetchText(url,3500)};}catch{return {url,page:null};}
  }));
  for(const item of pages){
    if(item.status!=="fulfilled"||!item.value?.page?.html)continue;
    const {url,page}=item.value;
    const finalUrl=page.final_url||url;
    const pageText=stripHtml(page.html).slice(0,26000);
    let owned=ownedWebsiteFromMatchedPage(finalUrl,pageText,lead);
    if(!owned&&knownThirdPartyDirectoryHost(finalUrl)){
      const outbound=outboundFirmWebsiteFromDirectory(page.html,lead);
      if(outbound)owned=await verifyOwnedWebsiteCandidate(outbound,lead);
      if(owned)await redis.hIncrBy(STATS,"website_preflight_directory_outbound_hit",1);
    }
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
          const duckUrl="https://html.duckduckgo.com/html/?q="+encodeURIComponent(q);
          const duck=await fetchText(duckUrl,5000);
          const duckLinks=[...new Set([...duckResultLinks(duck?.html||""),...markdownResultLinks(duck?.html||"")])];
          const expectedDuck=duckLinks.filter(u=>lawSourceRank(u,lead)===0);
          if(expectedDuck.length){
            resultLinks=[...new Set([...expectedDuck,...resultLinks])];
            await redis.hIncrBy(STATS,"duck_expected_bar_query_hit",1);
            await redis.hIncrBy(STATS,"duck_expected_bar_result_links",expectedDuck.length);
          }else{
            await redis.hIncrBy(STATS,"duck_expected_bar_query_miss",1);
          }
        }catch{
          await redis.hIncrBy(STATS,"duck_expected_bar_fetch_error",1);
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
      const queryText=String(result.q||"");
      const legalIntent=/notice to creditors|attorney for|represented by|bankruptcy|legal notice|email court|email bar|filetype:pdf/i.test(queryText);
      const professionalDirectoryIntent=/member directory|association email|affiliate.*email|estate planning council|professional directory/i.test(queryText);
      const ranked=(result.resultLinks||bingResultLinks(result.html))
        .filter(u=>{
          const rank=lawSourceRank(u,lead);
          if(rank>=90)return false;
          if(rank===0)return true;
          if(rank<=4&&legalRecordUrlLikely(u))return true;
          if(/\.pdf(?:$|[?#])/i.test(u)&&legalRecordUrlLikely(u))return true;
          if(legalIntent&&legalRecordUrlLikely(u))return true;
          if(professionalDirectoryIntent&&professionalDirectoryUrlLikely(u))return true;
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
          (legalIntent||professionalDirectoryIntent)?legalRecords:
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
      const evidenceUrl=String(page.final_url||target);
      const deepEvidence=/\.pdf(?:$|[?#])/i.test(evidenceUrl)||professionalDirectoryUrlLikely(evidenceUrl);
      const pageText=stripHtml(page.html).slice(0,deepEvidence?180000:22000);
      if(!pageMatchesLead(pageText,lead,evidenceUrl))continue;
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
      const headcountSource=String(page.final_url||target);
      const sourceRank=lawSourceRank(headcountSource,lead);
      const estimate=isPublishedHeadcountSource(headcountSource,lead)
        ? (sourceRank<=1?officialFirmSizeEstimate(pageText):attorneyEstimate(page.html,pageText))
        : 0;
      if(estimate>attorneyCount){attorneyCount=estimate;attorneyCountSource=headcountSource;}
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
  const phoneReady=isUsableLawPhone(lead.phone);
  const prioritizeSize=phoneReady||existingEmails.length>0||lead.conversion_headcount_priority===true||chicagoWebsiteBuild;
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
    const sourceRank=lawSourceRank(finalUrl,lead);
    const estimate=isPublishedHeadcountSource(finalUrl,lead)
      ? (sourceRank<=1?officialFirmSizeEstimate(pageText):attorneyEstimate(html,pageText))
      : 0;
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
  const waves=(phoneReady||lead.conversion_headcount_priority===true||chicagoWebsiteBuild)
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

    const deepPageLimit=(phoneReady||lead.conversion_headcount_priority===true||chicagoWebsiteBuild)?3:0;
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
  if(normalizedStateCode(lead)==="GA"&&host==="gabar.reliaguide.com")return true;
  return /texasbar\.com|floridabar\.org|calbar\.ca\.gov|nycourts\.gov|iardc\.org|supremecourt|disciplinaryboard|statebar|barassociation/i.test(host)||
    host.endsWith(".gov");
}
function lawSourceRank(url="",lead={}){
  let host="";try{host=new URL(String(url||"")).hostname.toLowerCase().replace(/^www\./,"");}catch{return 99;}
  const expected=expectedBarHost(lead);
  if(expected&&(host===expected||host.endsWith("."+expected)))return 0;
  if(normalizedStateCode(lead)==="GA"&&host==="gabar.reliaguide.com")return 1;
  if(trustedLawSource(url,lead))return 1;
  if(/govinfo\.gov|docs\.justia\.com|floridapublicnotices\.com|publicnotices|docketalarm\.com|trellis\.law/i.test(host))return 2;
  if(/justia\.com|lawyers\.com|martindale\.com|findlaw\.com|avvo\.com|superlawyers\.com|attorneydir\.com|lawyer-map\.com/i.test(host))return 3;
  if(/allbiz\.com|chamberofcommerce\.com|manta\.com|bbb\.org/i.test(host))return 4;
  if(/facebook\.com|linkedin\.com|instagram\.com|tiktok\.com|youtube\.com|x\.com|twitter\.com|pinterest\.com|mapquest\.com/i.test(host))return 90;
  return 6;
}
function professionalDirectoryUrlLikely(url=""){
  let u;try{u=new URL(String(url||""));}catch{return false;}
  const host=u.hostname.toLowerCase().replace(/^www\./,"");
  const path=(u.pathname+" "+u.search).toLowerCase();
  // Only public professional/member directory and council/association surfaces.
  // Content still must pass pageMatchesLead / exact phone identity before email use.
  return /(?:realtor|mls|barassociation|estateplanning|estate-planning|professional|chamber|association|council)/i.test(host)||
    /(?:affiliate|affiliates|member-directory|membership|members|directory|estate[-_]?planning|professional[-_]?directory)/i.test(path);
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
    if(!profiles.length){
      // Florida's directory supports direct firm/city search. This is much
      // stronger and cheaper than asking a web search engine for profile URLs.
      const rawFirm=String(lead.name||lead.title||"").replace(/["']/g," ").replace(/\s+/g," ").trim();
      const firmVariants=[...new Set([
        rawFirm,
        rawFirm.replace(/\b(?:attorneys?\s+at\s+law|law\s+offices?|law\s+firm|llc|pllc|p\.?a\.?|p\.?c\.?|llp|apc)\b/gi," ").replace(/[,.;]+/g," ").replace(/\s+/g," ").trim()
      ].filter(x=>x.length>=3))].slice(0,2);
      const city=normalizedLeadCity(lead);
      for(const firm of firmVariants){
        try{
          await redis.hIncrBy(STATS,"direct_floridabar_search_attempt",1);
          const searchUrl="https://www.floridabar.org/directories/find-mbr/?lName=&lNameSdx=N&fName=&fNameSdx=N&eligible=N&deceased=N&firm="+encodeURIComponent(firm)+"&locValue="+encodeURIComponent(city)+"&locType=C&pracAreas=&lawSchool=&services=&langs=&certValue=&pageNumber=1&pageSize=20";
          const page=await fetchText(searchUrl,7000);
          const html=String(page?.html||"");
          for(const m of html.matchAll(/href=["']([^"']*\/directories\/find-mbr\/profile\/\?[^"']*num=\d+[^"']*)["']/gi)){
            try{
              const href=new URL(String(m[1]||""),searchUrl).href.split("#")[0];
              if(!profiles.includes(href))profiles.push(href);
            }catch{}
          }
          console.log(JSON.stringify({
            event:"law_floridabar_direct_firm_search",
            name:String(lead.name||lead.title||""),
            firm,
            city,
            profiles:profiles.length,
            searchUrl
          }));
          if(profiles.length){
            await redis.hIncrBy(STATS,"direct_floridabar_profile_links",profiles.length);
            break;
          }
        }catch(error){
          await redis.hIncrBy(STATS,"direct_floridabar_search_error",1);
          console.warn(JSON.stringify({event:"law_floridabar_direct_firm_error",name:String(lead.name||lead.title||""),error:String(error?.message||error).slice(0,220)}));
        }
      }
    }
    if(profiles.length)return profiles.slice(0,8);
  }
  // High-volume state adapters. Exact phone is the strongest identity key when
  // Maps gives us a firm name but not a clean attorney name.
  const officialHosts={
    TX:"texasbar.com",
    IL:"iardc.org",
    GA:"gabar.org",
    NC:"portal.ncbar.gov",
    WA:"wsba.org",
    FL:"floridabar.org"
  };
  if(officialHosts[state]){
    const host=officialHosts[state];
    const out=[];
    const names=[...new Set((people||[]).filter(Boolean).slice(0,2))];
    const firm=String(lead.name||lead.title||"").replace(/["']/g," ").replace(/\s+/g," ").trim();
    const phoneDigits=String(lead.phone||"").replace(/\D/g,"").slice(-10);
    const phonePretty=phoneDigits.length===10?phoneDigits.slice(0,3)+"-"+phoneDigits.slice(3,6)+"-"+phoneDigits.slice(6):"";
    if(state==="GA"){
      const gaQueries=[
        ...(phonePretty?['site:gabar.reliaguide.com/lawyer "'+phonePretty+'"']:[]),
        ...names.map(n=>'site:gabar.reliaguide.com/lawyer "'+n+'"'),
        ...(firm?['site:gabar.reliaguide.com/lawyer "'+firm+'"']:[])
      ].slice(0,3);
      for(const q of gaQueries){
        try{
          await redis.hIncrBy(STATS,"direct_gabar_search_attempt",1);
          const [bingPage,duckPage]=await Promise.allSettled([
            fetchText("https://www.bing.com/search?q="+encodeURIComponent(q),5000),
            fetchText("https://html.duckduckgo.com/html/?q="+encodeURIComponent(q),5000)
          ]);
          const bingHtml=bingPage.status==="fulfilled"?String(bingPage.value?.html||""):"";
          const duckHtml=duckPage.status==="fulfilled"?String(duckPage.value?.html||""):"";
          const links=[...new Set([
            ...bingResultLinks(bingHtml),
            ...duckResultLinks(duckHtml),
            ...markdownResultLinks(bingHtml),
            ...markdownResultLinks(duckHtml)
          ])]
            .filter(u=>{
              try{
                const x=new URL(u);
                return x.hostname.toLowerCase()==="gabar.reliaguide.com"&&/^\/lawyer\/[^/]+/i.test(x.pathname)&&!/\/lawyer\/search/i.test(x.pathname);
              }catch{return false;}
            })
            .slice(0,6);
          if(links.length){
            await redis.hIncrBy(STATS,"direct_gabar_profile_links",links.length);
            return links;
          }
        }catch{
          await redis.hIncrBy(STATS,"direct_gabar_search_error",1);
        }
      }
    }
    const queries=[...(phonePretty?["site:"+host+" \""+phonePretty+"\""]:[]),...names.map(n=>"site:"+host+" \""+n+"\""),...(firm?["site:"+host+" \""+firm+"\""]:[])].slice(0,3);
    for(const q of queries){
      try{
        await redis.hIncrBy(STATS,"direct_"+state.toLowerCase()+"bar_search_attempt",1);
        const [bingPage,bingRss,duckPage]=await Promise.allSettled([
          fetchText("https://www.bing.com/search?q="+encodeURIComponent(q),5000),
          fetchText("https://www.bing.com/search?format=rss&q="+encodeURIComponent(q),5000),
          fetchText("https://html.duckduckgo.com/html/?q="+encodeURIComponent(q),5000)
        ]);
        const bingHtml=bingPage.status==="fulfilled"?String(bingPage.value?.html||""):"";
        const rssHtml=bingRss.status==="fulfilled"?String(bingRss.value?.html||""):"";
        const duckHtml=duckPage.status==="fulfilled"?String(duckPage.value?.html||""):"";
        const links=[...new Set([
          ...bingResultLinks(bingHtml),
          ...bingRssResultLinks(rssHtml),
          ...duckResultLinks(duckHtml),
          ...markdownResultLinks(bingHtml),
          ...markdownResultLinks(duckHtml)
        ])]
          .filter(u=>{
            const h=hostOf(u);
            if(!h||!(h===host||h.endsWith("."+host)))return false;
            if(state==="TX")return /Template\.cfm\?[^#]*ContactID=\d+/i.test(u);
            if(state==="IL")return /lawyer/i.test(u);
            if(state==="GA")return /\/member-directory\/?\?[^#]*\bid=[A-Za-z0-9]+/i.test(u);
            if(state==="NC")return /verification|member|search/i.test(u);
            if(state==="WA")return /legal-directory|lawyer|member|profile|search/i.test(u);
            if(state==="FL")return /\/directories\/find-mbr\/profile\/\?[^#]*num=\d+/i.test(u);
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


function isPublishedHeadcountSource(source="",lead={}){
  try{
    const u=new URL(String(source||""));
    const host=u.hostname.toLowerCase().replace(/^www\./,"");
    if(!/^https?:$/.test(u.protocol))return false;
    if(/(^|\.)(lawyers|martindale|lawyer|findlaw|justia)\.com$/i.test(host))return true;
    if(/^(?:lawyers\.)?law\.cornell\.edu$/i.test(host)||/^lawyers\.oyez\.org$/i.test(host)||/^lawyers\.lawyerlegion\.com$/i.test(host))return true;
    const expected=expectedBarHost(lead);
    if(expected&&(host===expected||host.endsWith("."+expected)))return true;
    if(normalizedStateCode(lead)==="GA"&&host==="gabar.reliaguide.com")return true;
    return false;
  }catch{return false;}
}

const HEADCOUNT_IDENTITY_VERSION="headcount-identity-v4-fetched-source-only";

function headcountSourceNeedsV2Identity(source=""){
  const host=hostOf(source);
  return /(^|\.)(?:lawyer|lawyers|martindale|findlaw|justia)\.com$/i.test(host) ||
    /^(?:lawyers\.)?law\.cornell\.edu$/i.test(host) ||
    /^lawyers\.oyez\.org$/i.test(host) ||
    /^lawyers\.lawyerlegion\.com$/i.test(host);
}

function hasValidStoredHeadcount(lead={}){
  const n=Number(lead.attorney_count_estimate||lead.attorney_count||0);
  const source=String(lead.attorney_count_source||"");
  if(lead.attorney_count_evidence_verified!==true||!(n>0)||!isPublishedHeadcountSource(source,lead))return false;
  if(headcountSourceNeedsV2Identity(source)&&String(lead.headcount_identity_version||"")!==HEADCOUNT_IDENTITY_VERSION)return false;
  return true;
}

function durableHeadcountEvidenceValid(evidence={},lead={}){
  const source=String(evidence?.source||"");
  if(!(Number(evidence?.count||0)>0)||!isPublishedHeadcountSource(source,lead))return false;
  if(headcountSourceNeedsV2Identity(source)&&!String(evidence?.verification||"").includes(HEADCOUNT_IDENTITY_VERSION))return false;
  return true;
}

function strictLawyerComIdentityMatch(source="",text="",lead={}){
  if(!/(^|\.)lawyer\.com$/i.test(hostOf(source)))return sourcePageMatchesFirmIdentity(text,lead,source);
  const plain=normalize(text);
  const fullName=normalize(lead.name||lead.title||"");
  const fullNameMatch=Boolean(fullName.length>=8&&plain.includes(fullName));
  const phone=String(lead.phone||"").replace(/\D/g,"").slice(-10);
  const phoneMatch=Boolean(phone&&String(text).replace(/\D/g,"").includes(phone));
  const city=normalize(normalizedLeadCity(lead));
  const state=normalize(normalizedStateCode(lead)||lead.region||lead.state||lead.state_code||"");
  const geoMatch=Boolean((city&&plain.includes(city))||(state&&state.length>=2&&plain.includes(state)));

  let slug="";
  try{
    const u=new URL(String(source||""));
    slug=decodeURIComponent((u.pathname.match(/\/firm\/([^/]+)\.html/i)||[])[1]||"").replace(/[-_]+/g," ");
  }catch{}
  const stop=new Set(["the","law","legal","firm","office","offices","attorney","attorneys","lawyer","lawyers","of","and","group","llc","pllc","pc","pa","p","c"]);
  const nameTokens=normalize(lead.name||lead.title||"").split(" ").filter(t=>t.length>=3&&!stop.has(t));
  const slugTokens=normalize(slug).split(" ").filter(t=>t.length>=3&&!stop.has(t));
  const overlap=nameTokens.filter(t=>slugTokens.some(s=>tokenAffinity(s,t))).length;
  const strongSlug=nameTokens.length>=2&&overlap>=Math.min(2,nameTokens.length);

  // Lawyer.com fuzzy redirects can land on a completely different firm.
  // Accept only when the final firm slug corroborates the target identity,
  // plus either exact phone or exact firm name/geography.
  return strongSlug&&(phoneMatch||(fullNameMatch&&geoMatch));
}

async function enrichLead(key,lead){
  const enrichStartedAt=Date.now();
  if(String(lead.search_profile||"")!=="law-firm"&&normalize(lead.industry)!=="law firm")return false;
  if(!isLawFirmLead(lead)){
    await redis.sAdd(ENRICHED_SET,key);
    await redis.sAdd(REJECTED_SET,key);
    await Promise.all([redis.sRem(READY_SET,key),redis.sRem(EMAIL_CANDIDATE_SET,key),redis.sRem(UNIQUE_ELIGIBLE_SET,key),redis.sRem(CALL_READY_SET,key)]);
    await redis.hIncrBy(STATS,"rejected_not_law_firm",1);
    return true;
  }
  const alreadyEnriched=await redis.sIsMember(ENRICHED_SET,key);
  const needsPhoneHeadcountResearch=
    !String(lead.website||lead.website_url||"").trim() &&
    isUsableLawPhone(lead.phone) &&
    lead.attorney_count_evidence_verified!==true;
  // A record being "enriched" under the old email-first campaign must not block
  // the new phone-first headcount pass. Re-open callable no-site firms until
  // firm size is actually proved.
  if(alreadyEnriched&&!needsPhoneHeadcountResearch)return false;
  if(alreadyEnriched&&needsPhoneHeadcountResearch){
    await redis.sRem(ENRICHED_SET,key);
    await redis.hIncrBy(STATS,"phone_first_reopened_enriched",1);
  }

  let durableHeadcountEvidence=null;
  try{
    const rawHeadcount=await redis.hGet(VERIFIED_HEADCOUNT_EVIDENCE_HASH,key);
    if(rawHeadcount)durableHeadcountEvidence=JSON.parse(rawHeadcount);
  }catch{}
  if(durableHeadcountEvidenceValid(durableHeadcountEvidence,lead)){
    lead={...lead,
      attorney_count_estimate:Number(durableHeadcountEvidence.count),
      attorney_count_evidence_verified:true,
      attorney_count_source:String(durableHeadcountEvidence.source||""),
      attorney_count_verified_at:String(durableHeadcountEvidence.verified_at||lead.attorney_count_verified_at||"")
    };
    await redis.hSet(LEAD_HASH,key,JSON.stringify(lead));
    await redis.sAdd(UNIQUE_VERIFIED_HEADCOUNT_SET,key);
  }
  const storedHeadcountValid=hasValidStoredHeadcount(lead);
  if(lead.attorney_count_evidence_verified===true&&!storedHeadcountValid){
    lead={...lead,attorney_count_evidence_verified:false,attorney_count_estimate:0,attorney_count_source:"",firm_size_tier:"unknown",preferred_firm_size:false};
    await redis.hSet(LEAD_HASH,key,JSON.stringify(lead));
    await Promise.all([
      redis.sRem(UNIQUE_VERIFIED_HEADCOUNT_SET,key),
      redis.sRem(UNIQUE_ELIGIBLE_SET,key),
      redis.sRem(READY_SET,key)
    ]);
    await redis.hDel(VERIFIED_HEADCOUNT_EVIDENCE_HASH,key);
    await redis.hIncrBy(STATS,"invalid_bar_headcount_cleared",1);
  }
  const knownVerifiedCount=storedHeadcountValid?Number(lead.attorney_count_estimate||0):0;
  const knownSizeReady=knownVerifiedCount>=2&&knownVerifiedCount<=10;
  const emailRecoveryAttempt=Math.max(0,Number(lead.email_recovery_attempts||0));
  if(knownVerifiedCount>0&&(knownVerifiedCount<2||knownVerifiedCount>10)){
    await redis.sAdd(UNIQUE_VERIFIED_HEADCOUNT_SET,key);
    await redis.sAdd(ENRICHED_SET,key);
    await redis.sAdd(REJECTED_SET,key);
    await Promise.all([
      redis.sRem(READY_SET,key),redis.sRem(EMAIL_CANDIDATE_SET,key),
      redis.sRem(PENDING_SET,key),redis.sRem(PRIORITY_PENDING_SET,key),
      redis.sRem(RECOVERABLE_PENDING_SET,key),redis.sRem(SOURCE_PENDING_SET,key),
      redis.sRem(SIZE_READY_PENDING_SET,key),redis.sRem(CHICAGO_PENDING_SET,key)
    ]);
    await redis.hIncrBy(STATS,"known_wrong_size_short_circuit",1);
    return true;
  }

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
    isUsableLawPhone(lead.phone);
  if(/^https?:\/\//i.test(website)){
    await redis.sAdd(ENRICHED_SET,key);
    await redis.sAdd(REJECTED_SET,key);
    await Promise.all([redis.sRem(READY_SET,key),redis.sRem(EMAIL_CANDIDATE_SET,key),redis.sRem(UNIQUE_ELIGIBLE_SET,key),redis.sRem(CALL_READY_SET,key),redis.sRem(CHICAGO_PENDING_SET,key)]);
    await redis.hIncrBy(STATS,"rejected_has_website",1);
    return true;
  }

  // Cheap no-website integrity check for the verified 2-10 cohort. Reuse the
  // exact trusted headcount profile here, but defer broad web search until a
  // source-verified email exists. Historical data showed broad website
  // preflight had very low hit rate and was burning conversion capacity before
  // the mandatory email gate.
  if(knownSizeReady){
    const profileSite=await ownedWebsiteFromTrustedProfile(String(lead.attorney_count_source||""),lead,key);
    const discoveredSizeReadySite=profileSite;
    if(discoveredSizeReadySite){
      const updated={...lead,website:discoveredSizeReadySite,website_opportunity:"website_refresh",owned_website_evidence_source:"size_ready_profile"};
      await redis.hSet(LEAD_HASH,key,JSON.stringify(updated));
      await Promise.all([
        redis.sRem(READY_SET,key),redis.sRem(EMAIL_CANDIDATE_SET,key),
        redis.sRem(PENDING_SET,key),redis.sRem(PRIORITY_PENDING_SET,key),
        redis.sRem(RECOVERABLE_PENDING_SET,key),redis.sRem(SOURCE_PENDING_SET,key),
        redis.sRem(SIZE_READY_PENDING_SET,key)
      ]);
      await redis.sAdd(REJECTED_SET,key);
      await redis.sAdd(ENRICHED_SET,key);
      await redis.sRem(UNIQUE_ELIGIBLE_SET,key);
      await redis.hIncrBy(STATS,"size_ready_owned_website_hit",1);
      console.log(JSON.stringify({event:"law_size_ready_owned_website_reject",key,name:String(lead.name||lead.title||""),website:discoveredSizeReadySite,attorneyCount:knownVerifiedCount}));
      return true;
    }
  }

  // Phone-first throughput: do NOT run the expensive owned-site search on
  // every callable record. Prove 2-10 attorneys first, then spend website
  // verification only on the much smaller cohort that could actually qualify.
  // Existing verified-size records still use the knownSizeReady gate above.
  if(chicagoHeadcountCampaign){
    await redis.hIncrBy(STATS,"website_preflight_deferred_until_size",1);
  }else{
    await redis.hIncrBy(STATS,"website_preflight_deferred",1);
  }

  let durableEmailEvidence=null;
  try{
    const rawEvidence=await redis.hGet(VERIFIED_EMAIL_EVIDENCE_HASH,key);
    if(rawEvidence)durableEmailEvidence=JSON.parse(rawEvidence);
  }catch{}
  if(durableEmailEvidence?.source&&Array.isArray(durableEmailEvidence?.emails)&&durableEmailEvidence.emails.length){
    lead={...lead,
      emails:[...new Set([...(Array.isArray(lead.emails)?lead.emails:[]),...durableEmailEvidence.emails])],
      law_email_source:String(durableEmailEvidence.source),
      law_email_source_verified:true,
      law_email_validation:"published_exact+strict_firm_identity+mx",
      law_email_verified_at:String(durableEmailEvidence.verified_at||lead.law_email_verified_at||"")
    };
    await redis.hSet(LEAD_HASH,key,JSON.stringify(lead));
    await redis.sAdd(UNIQUE_VERIFIED_EMAIL_SET,key);
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

  // Proven 2-10 firms already have an identity-matched published headcount
  // source. Reuse that exact page before launching search engines. This is the
  // cheapest path for the current size-ready backlog and preserves provenance.
  if(!emails.length&&attorneyCountVerified&&attorneyCount>=2&&attorneyCount<=10){
    const headcountEmail=await publishedEmailEvidenceFromHeadcountSource(lead,key);
    if(headcountEmail.emails.length){
      emails.push(...headcountEmail.emails);
      source=headcountEmail.source;
      for(const email of headcountEmail.emails)emailEvidenceSources[String(email).toLowerCase()]=headcountEmail.source;
      emailMethod="headcount_source";
      await redis.hIncrBy(STATS,"email_headcount_source_hit",1);
    }
    if(Array.isArray(headcountEmail.attorneyNames)&&headcountEmail.attorneyNames.length){
      lead={...lead,directory_attorney_names:[...new Set([
        ...(Array.isArray(lead.directory_attorney_names)?lead.directory_attorney_names:[]),
        ...headcountEmail.attorneyNames
      ])].slice(0,10)};
      await redis.hSet(LEAD_HASH,key,JSON.stringify(lead));
      await redis.hIncrBy(STATS,"headcount_source_roster_identity_lead",1);
    }
  }

  // Prove 2-10 attorneys before spending the expensive broad email-discovery
  // pass, but keep the campaign contract explicit: phone + verified 2-10 +
  // no-owned-site is only an intermediate candidate. A source-verified usable
  // email is still mandatory for strict eligibility.
  const phoneHeadcountPriority=!website&&isUsableLawPhone(lead.phone);
  if(!attorneyCountVerified&&phoneHeadcountPriority){
    let earlyCount=0,earlySource="",earlyWebsite="";
    // Cheap-to-expensive headcount waterfall. The previous order launched up
    // to 14 directory searches per lead before trying exact-phone roster lookup,
    // which made a 10k calling target impossible.
    try{
      const floridaRoster=await directFloridaFirmRosterHeadcountEvidence(lead,key);
      if(Number(floridaRoster?.count||0)>0&&isPublishedHeadcountSource(String(floridaRoster?.source||""),lead)){
        earlyCount=Number(floridaRoster.count);earlySource=String(floridaRoster.source);
        if(Array.isArray(floridaRoster.publishedEmails)&&floridaRoster.publishedEmails.length){
          emails.push(...floridaRoster.publishedEmails);
          source=String(floridaRoster.emailSource||floridaRoster.source||"");
          for(const email of floridaRoster.publishedEmails)emailEvidenceSources[String(email).toLowerCase()]=source;
          emailMethod="florida_roster";
        }
        await redis.hIncrBy(STATS,"phone_first_headcount_florida_firm_roster",1);
      }
    }catch{await redis.hIncrBy(STATS,"phone_first_headcount_florida_firm_roster_fail",1);}

    // Exact Lawyer.com firm URLs are cheap (three bounded direct fetches) and,
    // with the v8 dedicated-roster parser, now produce verified 2-10 counts.
    // Run this before broad phone/search roster work so a hit avoids dozens of
    // search-engine and directory requests.
    if(!earlyCount){
      try{
        const lawyer=await directLawyerComSizeEvidence(lead,key);
        if(Number(lawyer?.count||0)>0&&isPublishedHeadcountSource(String(lawyer?.source||""),lead)){
          earlyCount=Number(lawyer.count);earlySource=String(lawyer.source);
          if(Array.isArray(lawyer.attorneyNames)&&lawyer.attorneyNames.length){
            lead={...lead,directory_attorney_names:[...new Set([
              ...(Array.isArray(lead.directory_attorney_names)?lead.directory_attorney_names:[]),
              ...lawyer.attorneyNames
            ])].slice(0,10)};
          }
          if(Array.isArray(lawyer.publishedEmails)&&lawyer.publishedEmails.length){
            emails.push(...lawyer.publishedEmails);
            source=String(lawyer.emailSource||lawyer.source||"");
            for(const email of lawyer.publishedEmails)emailEvidenceSources[String(email).toLowerCase()]=source;
            emailMethod="lawyercom_profile";
          }
          await redis.hIncrBy(STATS,"phone_first_headcount_lawyercom",1);
        }
      }catch{await redis.hIncrBy(STATS,"phone_first_headcount_lawyercom_fail",1);}
    }

    if(!earlyCount){
      try{
        const roster=await phoneRosterHeadcountEvidence(lead,key);
        if(Number(roster?.count||0)>0&&isPublishedHeadcountSource(String(roster?.source||""),lead)){
          earlyCount=Number(roster.count);earlySource=String(roster.source);
          if(Array.isArray(roster.publishedEmails)&&roster.publishedEmails.length){
            emails.push(...roster.publishedEmails);
            source=String(roster.emailSource||roster.source||"");
            for(const email of roster.publishedEmails)emailEvidenceSources[String(email).toLowerCase()]=source;
            emailMethod="phone_roster";
          }
          await redis.hIncrBy(STATS,"phone_first_headcount_phone_roster",1);
        }
      }catch{await redis.hIncrBy(STATS,"phone_first_headcount_phone_roster_fail",1);}
    }

    if(!earlyCount){
      try{
        const direct=await directDirectorySizeEvidence(lead,key);
        earlyCount=Number(direct?.count||0);
        earlySource=String(direct?.source||"");
        earlyWebsite=String(direct?.website||"");
        if(earlyCount>0)await redis.hIncrBy(STATS,"phone_first_headcount_direct_directory",1);
      }catch{await redis.hIncrBy(STATS,"phone_first_headcount_direct_directory_fail",1);}
    }

    if(earlyWebsite){
      const updated={...lead,website:earlyWebsite,website_opportunity:"website_refresh",owned_website_evidence_source:earlySource||"phone_first_directory"};
      await redis.hSet(LEAD_HASH,key,JSON.stringify(updated));
      await Promise.all([
        redis.sRem(CALL_READY_SET,key),redis.sRem(CHICAGO_PENDING_SET,key),
        redis.sRem(READY_SET,key),redis.sRem(EMAIL_CANDIDATE_SET,key),redis.sRem(UNIQUE_ELIGIBLE_SET,key)
      ]);
      await redis.sAdd(REJECTED_SET,key);
      await redis.sAdd(ENRICHED_SET,key);
      await redis.hIncrBy(STATS,"phone_first_owned_website_hit",1);
      return true;
    }

    if(earlyCount>0&&earlySource){
      attorneyCount=earlyCount;
      attorneyCountVerified=true;
      attorneyCountSource=earlySource;
      lead={...lead,
        attorney_count_estimate:earlyCount,
        attorney_count_evidence_verified:true,
        attorney_count_source:earlySource,
        attorney_count_verified_at:new Date().toISOString(),
        headcount_identity_version:HEADCOUNT_IDENTITY_VERSION,
        phone_headcount_status:"verified",
        phone_headcount_method_version:PHONE_HEADCOUNT_METHOD_VERSION,
        preferred_firm_size:earlyCount>=2&&earlyCount<=10,
        firm_size_tier:firmSizeTier(earlyCount)
      };
      await redis.hSet(LEAD_HASH,key,JSON.stringify(lead));
      await redis.sAdd(UNIQUE_VERIFIED_HEADCOUNT_SET,key);
      await redis.hSet(VERIFIED_HEADCOUNT_EVIDENCE_HASH,key,JSON.stringify({
        count:earlyCount,source:earlySource,verified_at:new Date().toISOString(),
        verification:"published_identity_matched_headcount+"+HEADCOUNT_IDENTITY_VERSION
      }));

      if(earlyCount<2||earlyCount>10){
        await redis.sAdd(ENRICHED_SET,key);
        await redis.sAdd(REJECTED_SET,key);
        await Promise.all([
          redis.sRem(CALL_READY_SET,key),redis.sRem(CHICAGO_PENDING_SET,key),
          redis.sRem(READY_SET,key),redis.sRem(EMAIL_CANDIDATE_SET,key),redis.sRem(UNIQUE_ELIGIBLE_SET,key)
        ]);
        await redis.hIncrBy(STATS,"phone_first_wrong_size_short_circuit",1);
        return true;
      }

      // Headcount workers stop after proof. Only reject an owned site if the
      // exact trusted size source publishes it. The broad owned-site search is
      // deferred to the dedicated strict-email lane after email proof.
      const profileSite=await ownedWebsiteFromTrustedProfile(earlySource,lead,key);
      const discoveredSite=profileSite;
      if(discoveredSite){
        const websiteLead={...lead,website:discoveredSite,website_opportunity:"website_refresh",owned_website_evidence_source:earlySource||"post_size_profile"};
        await redis.hSet(LEAD_HASH,key,JSON.stringify(websiteLead));
        await Promise.all([
          redis.sRem(CALL_READY_SET,key),redis.sRem(CHICAGO_PENDING_SET,key),
          redis.sRem(READY_SET,key),redis.sRem(EMAIL_CANDIDATE_SET,key),redis.sRem(UNIQUE_ELIGIBLE_SET,key)
        ]);
        await redis.sAdd(REJECTED_SET,key);
        await redis.sAdd(ENRICHED_SET,key);
        await redis.hIncrBy(STATS,"phone_first_post_size_owned_website_hit",1);
        return true;
      }

      const wasCallReady=await redis.sIsMember(CALL_READY_SET,key);
      await redis.sAdd(CALL_READY_SET,key);
      if(!wasCallReady){
        const earlyEvidence=[lead.category,lead.name,lead.description,lead.descriptions].filter(Boolean).join(" ");
        const earlyPracticeKeys=[...new Set([
          ...(Array.isArray(lead.practice_keys)?lead.practice_keys:[]),
          ...lawFirmPracticeKeys(earlyEvidence),
          ...(String(lead.practice_focus||"").trim()?[String(lead.practice_focus).trim()]:[])
        ])];
        console.log(JSON.stringify({
          event:"law_call_ready_new",
          key,
          firm:String(lead.name||lead.title||"").trim(),
          phone:String(lead.phone||"").trim(),
          email:(lead.law_email_source_verified===true||lead.email_source_verified===true)?(emails[0]||""):"",
          emailEligible:Boolean((lead.law_email_source_verified===true||lead.email_source_verified===true)&&emails.length),
          attorneys:earlyCount,
          headcountSource:earlySource,
          address:String(lead.address||""),
          city:String(lead.city||""),
          state:String(lead.region||lead.state||""),
          maps:String(lead.google_maps_url||lead.maps_url||""),
          priority:Number(lead.lead_priority_score||0)||0,
          practiceKeys:earlyPracticeKeys,
          practiceAreas:lawFirmPracticeAreas(earlyEvidence),
          personalAngle:String(lead.personalization_fact||""),
          source:earlySource
        }));
      }

      if(!emails.length){
        const earlyEvidence=[lead.category,lead.name,lead.description,lead.descriptions].filter(Boolean).join(" ");
        const earlyPracticeKeys=[...new Set([
          ...(Array.isArray(lead.practice_keys)?lead.practice_keys:[]),
          ...lawFirmPracticeKeys(earlyEvidence),
          ...(String(lead.practice_focus||"").trim()?[String(lead.practice_focus).trim()]:[])
        ])].filter(k=>LAW_PRACTICES.some(p=>p.key===k)).slice(0,3);
        const earlyPractices=earlyPracticeKeys.map(k=>LAW_PRACTICES.find(p=>p.key===k)?.label).filter(Boolean);
        lead={...lead,
          call_ready_lead:true,
          qualified_lead:false,
          practice_keys:earlyPracticeKeys,
          practice_areas:earlyPractices,
          lead_type:earlyPractices.join(" + "),
          preferred_firm_size:true,
          firm_size_tier:firmSizeTier(earlyCount),
          primary_pain_point:"No website",
          website_opportunity:"website_build",
          law_firm_enriched_at:new Date().toISOString(),
          law_email_validation:"recovery_pending"
        };
        await redis.hSet(LEAD_HASH,key,JSON.stringify(lead));
        await redis.sRem(REJECTED_SET,key);
        // Do not make a headcount worker spend the rest of its slot on a broad
        // email search. Persist the proven 2-10/no-site lead and let the
        // conversion-first SIZE_READY lane finish the mandatory email gate.
        await redis.hIncrBy(STATS,"size_ready_email_deferred",1);
        return true;
      }
    }

    // The calling lane is headcount-only. If the fast verified public-source
    // waterfall could not prove firm size, persist the miss and move on instead
    // of spending another ~40s on email discovery. This preserves truthfulness:
    // unresolved size is not exported as 2-10.
    if(!attorneyCountVerified){
      const attempts=Math.max(0,Number(lead.phone_headcount_attempts||0))+1;
      const unresolved={...lead,
        phone_headcount_attempts:attempts,
        phone_headcount_last_at:new Date().toISOString(),
        phone_headcount_status:"unverified",
        phone_headcount_method_version:PHONE_HEADCOUNT_METHOD_VERSION,
        qualified_lead:false,
        call_ready_lead:false
      };
      await redis.hSet(LEAD_HASH,key,JSON.stringify(unresolved));
      await redis.sAdd(ENRICHED_SET,key);
      await redis.sAdd(REJECTED_SET,key);
      await Promise.all([
        redis.sRem(CALL_READY_SET,key),redis.sRem(READY_SET,key),
        redis.sRem(UNIQUE_ELIGIBLE_SET,key),redis.sRem(EMAIL_CANDIDATE_SET,key)
      ]);
      await redis.hIncrBy(STATS,"phone_first_headcount_unverified_fast_exit",1);
      return true;
    }
  }

  // Fastest conversion path: if the verified email already came from an
  // official bar profile, reuse that exact page for explicit "Firm Size"
  // evidence before launching expensive directory/search headcount work.
  if(!attorneyCountVerified&&existingSourceBacked&&trustedLawSource(existingSource,lead)){
    try{
      const profile=await fetchResearchPage(existingSource,lead,key,true);
      if(profile?.html){
        const profileUrl=String(profile.final_url||existingSource);
        const profileText=stripHtml(profile.html).slice(0,60000);
        if(sourcePageMatchesFirmIdentity(profileText,lead,profileUrl)){
          const officialCount=officialFirmSizeEstimate(profileText);
          if(officialCount>0){
            attorneyCount=officialCount;
            attorneyCountVerified=true;
            attorneyCountSource=profileUrl;
            await redis.hIncrBy(STATS,"official_profile_firm_size_hit",1);
            console.log(JSON.stringify({event:"law_official_profile_firm_size_hit",key,name:String(lead.name||lead.title||""),count:officialCount,source:profileUrl}));
          }
        }
      }
    }catch{
      await redis.hIncrBy(STATS,"official_profile_firm_size_fetch_fail",1);
    }
  }

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
      if(exactCount>0&&isPublishedHeadcountSource(exactCountSource,lead)){
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
    const phonePretty=phone.length===10?phone.slice(0,3)+"-"+phone.slice(3,6)+"-"+phone.slice(6):"";
    const phoneParen=phone.length===10?"("+phone.slice(0,3)+") "+phone.slice(3,6)+"-"+phone.slice(6):"";
    const city=normalizedLeadCity(lead),region=normalizedStateCode(lead)||String(lead.region||lead.state||lead.acquisition_location||"").trim();
    const people=attorneyNameVariants(lead);
    const person=people[0]||"";
    const alternate=people[1]||"";
    const barDomain=stateBarDomain(lead);
    const barQueries=stateBarQueries(lead,people);
    const state=normalizedStateCode(lead);
    const discoveredOfficialLinks=await directOfficialProfileLinks(lead,people);
    // If firm size was already proven from an official bar/court profile, that
    // exact page is our highest-value email source. Reuse it directly instead
    // of rediscovering the same identity through generic search.
    const directOfficialLinks=[...new Set([
      ...discoveredOfficialLinks,
      ...(attorneyCountSource&&trustedLawSource(attorneyCountSource,lead)?[attorneyCountSource]:[])
    ])];
    const publicRecordQueries=[
      ...(person&&phone?[`"${person}" "${phonePretty||phone}" email filetype:pdf`]:[]),
      ...(name?[`site:docs.justia.com "${name}" email`,`site:cases.justia.com "${name}" email`,`site:govinfo.gov "${name}" email`]:[]),
      ...(state==="FL"&&person?[`site:floridabar.org/about/volbars "${person}" email`]:[]),
      ...(name&&phone?[`"${name}" "${phonePretty||phone}" email`]:[]),
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
    const professionalDirectoryQueries=highValueLawResearchLead(lead)&&name?[
      `"${name}" "${phone||city}" "member directory" email`,
      `"${name}" "${city}" association email filetype:pdf`,
      `"${name}" "${region}" "affiliate" email`,
      `"${name}" "${region}" "estate planning council" email`,
      `"${name}" "${phonePretty||phone}" filetype:pdf email`
    ].filter(Boolean):[];
    const docketQueries=highValueLawResearchLead(lead)&&name?[
      `site:bkalerts.com "${name}" email`,
      `site:bankruptcyobserver.com "${name}" email`,
      `site:inforuptcy.com "${name}" email`
    ]:[];
    const directoryEmailQueries=[
      ...(phone?[`site:lawyers.com "${phonePretty||phone}"`,`site:findlaw.com "${phonePretty||phone}"`,`site:martindale.com "${phonePretty||phone}"`,`site:justia.com "${phonePretty||phone}"`]:[]),
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
      ...(phone&&name?[`"${name}" "${phonePretty||phone}" "Email"`]:[]),
      ...(phone?[`"${phonePretty||phone}" attorney "Email:"`,`"${phonePretty||phone}" lawyer email`,...(phoneParen?[`"${phoneParen}" attorney email`]:[])]:[]),
      ...directoryEmailQueries.slice(0,4),
      ...barQueries,
      ...professionalDirectoryQueries,
      ...docketQueries,
      ...publicRecordQueries,
      ...(name?[`"${name}" email filetype:pdf`]:[]),
      ...(name?[`"${name}" "E-mail" filetype:pdf`]:[]),
      // Wave 2: broader contact/directory recovery.
      ...(name?[`"${name}" ${city} ${region} contact email`.trim()]:[]),
      ...directoryEmailQueries.slice(4),
      ...(name?[`"${name}" ${region} "E-mail"`.trim()]:[]),
      ...(phone?[`"${phonePretty||phone}" attorney email`]:[]),
      ...(phone&&name?[`"${name}" "${phonePretty||phone}"`]:[]),
      ...(alternate?[`"${alternate}" ${region} attorney email`.trim()]:[])
    ].filter(Boolean))];
    const highValue=highValueLawResearchLead(lead);
    const soloShape=lawFirmNameShape(lead)==="solo";
    const hasDirectOfficial=directOfficialLinks.length>0;
    const sizeReadyEmailPriority=attorneyCountVerified&&attorneyCount>=2&&attorneyCount<=10;
    const sizeReadyAttempt=emailRecoveryAttempt;

    // Retry diversity matters more than repeating the same searches five times.
    // Proven 2-10/no-site passes rotate through bounded source waves:
    // official/exact identity -> public records -> professional directories -> broad recovery.
    const sizeReadyWave1=[...new Set([
      ...barQueries,
      ...(phone&&name?[`"${name}" "${phonePretty||phone}" email`]:[]),
      ...(person?[`"${person}" "${region}" attorney email`]:[]),
      ...(phone?[`"${phonePretty||phone}" attorney "Email:"`]:[])
    ].filter(Boolean))].slice(0,6);
    const sizeReadyWave2=[...new Set([
      ...publicRecordQueries,
      ...(person?[`"${person}" "${region}" "E-mail address" filetype:pdf`]:[]),
      ...(name?[`"${name}" "${region}" email filetype:pdf`]:[])
    ].filter(Boolean))].slice(0,10);
    const sizeReadyWave3=[...new Set([
      ...professionalDirectoryQueries,
      ...directoryEmailQueries.slice(0,8),
      ...docketQueries
    ].filter(Boolean))].slice(0,12);
    const sizeReadyWave4=[...new Set([
      ...directoryEmailQueries.slice(8),
      ...docketQueries,
      ...(name?[`"${name}" ${city} ${region} contact email`.trim(),`"${name}" "E-mail" filetype:pdf`]:[]),
      ...(alternate?[`"${alternate}" ${region} attorney email`.trim()]:[]),
      ...(phone?[`"${phonePretty||phone}" lawyer email`]:[])
    ].filter(Boolean))].slice(0,12);
    const sizeReadyQueries=!sizeReadyEmailPriority?[]:
      sizeReadyAttempt<=0?sizeReadyWave1:
      sizeReadyAttempt===1?sizeReadyWave2:
      sizeReadyAttempt===2?sizeReadyWave3:
      sizeReadyWave4;
    const runDuckForSizeReady=sizeReadyEmailPriority&&sizeReadyAttempt>=1;
    const dualSearch=runDuckForSizeReady||(!sizeReadyEmailPriority&&!hasDirectOfficial&&((!soloShape&&(highValue||emailRecoveryPriority(lead)>=5))||Number(lead.email_recovery_attempts||0)>=1));
    const effectiveQueries=sizeReadyEmailPriority
      ? sizeReadyQueries
      : (hasDirectOfficial?bingQueries.slice(0,4):(soloShape?bingQueries.slice(0,5):bingQueries));
    // When an official directory profile is already known, do not burn dozens
    // of generic search requests first. Fetch the authoritative profile plus a
    // tiny fallback set; only fan out to multiple engines when direct lookup
    // produced no profile at all.
    const [bingResult,duckResult]=await Promise.allSettled([
      bingFallback(
        lead,
        effectiveQueries,
        sizeReadyEmailPriority?(sizeReadyAttempt<=0?6:8):(hasDirectOfficial?4:(soloShape?5:(highValue?10:(dualSearch?8:7)))),
        key,
        [],
        sizeReadyEmailPriority?(sizeReadyAttempt<=0?2:3):(hasDirectOfficial?1:(highValue?2:1)),
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
      if(tdCount>0&&isPublishedHeadcountSource(tdSource,lead)){
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
      if(bfCount>0&&isPublishedHeadcountSource(bfCountSource,lead)){
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
  const runZeroCostThisAttempt=!(attorneyCountVerified&&attorneyCount>=2&&attorneyCount<=10)||emailRecoveryAttempt===0||emailRecoveryAttempt===3;
  if(runZeroCostThisAttempt&&!emails.length&&!researchOwnedWebsite&&attorneyNameVariants(lead).length&&((attorneyCountVerified&&attorneyCount>=2&&attorneyCount<=10)||emailRecoveryPriority(lead)>=5||emailRecoveryAttempt>=1)){
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
    await Promise.all([redis.sRem(READY_SET,key),redis.sRem(EMAIL_CANDIDATE_SET,key),redis.sRem(UNIQUE_ELIGIBLE_SET,key),redis.sRem(CALL_READY_SET,key)]);
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
  const priorVerified=lead.law_email_source_verified===true;
  for(const email of emails){
    const candidateSource=String(emailEvidenceSources[String(email).toLowerCase()]||source||"");
    const candidateRank=lawSourceRank(candidateSource,lead);

    // Authoritative Bar/court emails arrived here only after the source page was
    // fetched, pageMatchesLead() passed, and contextualEmails() found this exact
    // address on that page. Refetching the same official page adds latency but
    // no new verification value, and was causing good leads to hit the 75s job
    // timeout before durable evidence could be saved.
    if(candidateSource&&candidateRank<=1){
      sourceBoundEmails.push(email);
      boundSourceByEmail[String(email).toLowerCase()]=candidateSource;
      await redis.hIncrBy(STATS,"email_authoritative_source_binding_fastpath",1);
      continue;
    }

    const matched=await publishedEmailsOnExactSource(candidateSource,[email],lead,key);
    if(matched.length){
      sourceBoundEmails.push(email);
      boundSourceByEmail[String(email).toLowerCase()]=candidateSource;
    }else if(priorVerified&&existingCandidates.includes(String(email).toLowerCase())&&
      (matched.bindingStatus==="unavailable"||matched.bindingStatus==="error")){
      // Never destroy already-proven evidence because a source timed out.
      sourceBoundEmails.push(email);
      boundSourceByEmail[String(email).toLowerCase()]=candidateSource;
      await redis.hIncrBy(STATS,"email_verified_preserved_transient_recheck",1);
      console.log(JSON.stringify({event:"law_verified_email_preserved",key,name:String(lead.name||lead.title||""),email,source:candidateSource,status:matched.bindingStatus}));
    }
  }
  if(emails.length&&!sourceBoundEmails.length)await redis.hIncrBy(STATS,"email_source_binding_reject_leads",1);
  emails=sourceBoundEmails;

  // Official Bar/court records already passed source-page identity + exact
  // published email + MX. KeeLead is optional infrastructure and must not delay
  // or erase authoritative evidence. Keep KeeLead only as an extra signal for
  // non-authoritative web sources.
  const authoritativeBound=sourceBoundEmails.length>0&&sourceBoundEmails.every(email=>{
    const src=String(boundSourceByEmail[String(email).toLowerCase()]||"");
    return src&&lawSourceRank(src,lead)<=1;
  });
  if(!authoritativeBound)emails=await keeleadVerifiedEmails(emails);
  else await redis.hIncrBy(STATS,"email_authoritative_keelead_bypass",1);

  if(emails.length)source=String(boundSourceByEmail[String(emails[0]).toLowerCase()]||source||"");
  if(emails.length)await redis.hIncrBy(STATS,"email_keelead_pass_leads",1);
  else if(sourceBoundEmails.length)await redis.hIncrBy(STATS,"email_keelead_reject_leads",1);
  const emailSourceVerified=emails.length>0&&isDirectPublishedEmailSource(source);
  if(emailSourceVerified){
    await redis.hIncrBy(STATS,"email_source_verified_leads",1);
    await redis.sAdd(UNIQUE_VERIFIED_EMAIL_SET,key);
    const verifiedAt=new Date().toISOString();
    await redis.hSet(VERIFIED_EMAIL_EVIDENCE_HASH,key,JSON.stringify({
      emails:[...new Set(emails)],
      source,
      verified_at:verifiedAt,
      verification:"published_exact+strict_firm_identity+mx"
    }));
  }

  // Website eligibility comes before firm-size research. If the verified email
  // itself proves an owned firm domain/site, the lead is ineligible and there is
  // no reason to spend another Bing/Duck/Jina headcount pass.
  if(emailSourceVerified){
    const earlyEvidenceWebsite=await detectOwnedWebsiteFromEvidenceSource(source,emails,lead,key);
    const earlyDomainWebsite=earlyEvidenceWebsite||
      await detectOwnedWebsiteFromEmailDomains(emails,lead)||
      await probeLikelyOwnedDomains(lead,key)||
      await findOwnedWebsitePreflight(lead,key,true);
    if(earlyDomainWebsite){
      const updated={...lead,website:earlyDomainWebsite,website_opportunity:"website_refresh",owned_website_evidence_source:"verified_email_domain",law_email_enrich_version:EMAIL_METHOD_VERSION};
      await redis.hSet(LEAD_HASH,key,JSON.stringify(updated));
      await Promise.all([redis.sRem(READY_SET,key),redis.sRem(EMAIL_CANDIDATE_SET,key),redis.sRem(UNIQUE_ELIGIBLE_SET,key),redis.sRem(CALL_READY_SET,key)]);
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
        redis.sRem(UNIQUE_ELIGIBLE_SET,key),
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
    const phoneRoster=!attorneyCountVerified?await phoneRosterHeadcountEvidence(lead,key):{count:0,source:""};
    if(phoneRoster.count>0){
      attorneyCount=phoneRoster.count;
      attorneyCountVerified=true;
      attorneyCountSource=phoneRoster.source;
      await redis.hIncrBy(STATS,"post_email_headcount_verified",1);
      await redis.hIncrBy(STATS,"post_email_headcount_phone_roster",1);
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
        .filter(x=>x.count>0&&isPublishedHeadcountSource(x.source,lead))
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
  if(attorneyCountVerified){
    await redis.sAdd(UNIQUE_VERIFIED_HEADCOUNT_SET,key);
    if(attorneyCount>0&&isPublishedHeadcountSource(attorneyCountSource,lead)){
      await redis.hSet(VERIFIED_HEADCOUNT_EVIDENCE_HASH,key,JSON.stringify({
        count:Number(attorneyCount),
        source:String(attorneyCountSource||""),
        verified_at:new Date().toISOString(),
        verification:"published_identity_matched_headcount"
      }));
    }
  }
  if(attorneyCountVerified&&attorneyCount>=2&&attorneyCount<=10&&trustedLawSource(attorneyCountSource,lead)){
    const officialProfileWebsite=await ownedWebsiteFromTrustedProfile(attorneyCountSource,lead,key);
    if(officialProfileWebsite){
      const updated={...lead,website:officialProfileWebsite,website_opportunity:"website_refresh",owned_website_evidence_source:attorneyCountSource,attorney_count_estimate:attorneyCount,attorney_count_evidence_verified:true,attorney_count_source:attorneyCountSource};
      await redis.hSet(LEAD_HASH,key,JSON.stringify(updated));
      await Promise.all([
        redis.sRem(READY_SET,key),redis.sRem(EMAIL_CANDIDATE_SET,key),
        redis.sRem(UNIQUE_ELIGIBLE_SET,key),redis.sRem(CALL_READY_SET,key),redis.sRem(SIZE_READY_PENDING_SET,key)
      ]);
      await redis.sAdd(REJECTED_SET,key);
      await redis.sAdd(ENRICHED_SET,key);
      await redis.hIncrBy(STATS,"official_profile_owned_website_hit",1);
      console.log(JSON.stringify({event:"law_official_profile_owned_website_reject",key,name:String(lead.name||lead.title||""),website:officialProfileWebsite,attorneyCount,source:attorneyCountSource}));
      return true;
    }
  }

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
  const callReady=!effectiveWebsite&&isUsableLawPhone(lead.phone)&&attorneyCountVerified&&attorneyCount>=2&&attorneyCount<=10;
  if(callReady){
    const wasCallReady=await redis.sIsMember(CALL_READY_SET,key);
    await redis.sAdd(CALL_READY_SET,key);
    if(!wasCallReady){
      console.log(JSON.stringify({
        event:"law_call_ready_new",
        key,
        firm:String(lead.name||lead.title||"").trim(),
        phone:String(lead.phone||"").trim(),
        email:emailSourceVerified?(emails[0]||""):"",
        emailEligible:Boolean(emailSourceVerified&&emails.length),
        attorneys:attorneyCount,
        headcountSource:String(attorneyCountSource||""),
        address:String(lead.address||""),
        city:String(lead.city||""),
        state:String(lead.region||lead.state||""),
        maps:String(lead.google_maps_url||lead.maps_url||""),
        priority:Number(lead.lead_priority_score||0)||0,
        practiceKeys,
        practiceAreas:practices,
        personalAngle:String(p.fact||""),
        source:emailSourceVerified?String(source||""):String(attorneyCountSource||lead.personalization_source||lead.google_maps_url||lead.maps_url||"")
      }));
    }
  }else await redis.sRem(CALL_READY_SET,key);
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

  const recoveryAttempts=emailRecoveryAttempt;
  const enriched={...lead,email_recovery_attempts:recoveryAttempts,website:effectiveWebsite,emails,attorney_count_estimate:attorneyCount||null,attorney_count_evidence_verified:attorneyCountVerified,attorney_count_source:attorneyCountSource||"",headcount_identity_version:attorneyCountVerified?HEADCOUNT_IDENTITY_VERSION:"",preferred_firm_size:preferredSize,
    firm_size_tier:sizeTier,practice_areas:practices,practice_keys:practiceKeys,
    lead_type:practices.join(" + "),personalization_fact:p.fact,personalization_source:p.source,
    personalization_quality:p.quality,website_opportunity:"website_build",website_audit:null,primary_pain_point:painPoint,
    target_area:String(lead.acquisition_location||[lead.city,lead.region].filter(Boolean).join(", ")||"").trim(),
    email_angle:emailAngle,lead_priority_score:priority,qualified_lead:qualified,call_ready_lead:callReady,
    law_email_enrich_version:EMAIL_METHOD_VERSION,
    size_ready_email_method_version:(attorneyCountVerified&&attorneyCount>=2&&attorneyCount<=10&&!effectiveWebsite)?SIZE_READY_EMAIL_METHOD_VERSION:String(lead.size_ready_email_method_version||""),
    law_email_method:emailMethod,law_email_source:source||"",
    law_email_source_verified:emailSourceVerified,
    law_email_validation:emailSourceVerified?(KEELEAD_BASE_URL?"published_exact+strict_firm_identity+mx+optional_smtp":"published_exact+strict_firm_identity+mx"):"rejected",
    law_email_mailbox_verified:false,
    law_bar_domain:stateBarDomain(lead),
    law_firm_enriched_at:new Date().toISOString()};

  // Email is a hard eligibility gate. Spend materially more research on the
  // tiny cohort that already proved 2-10 attorneys + no owned website.
  const sizeReadyForEmail=attorneyCountVerified&&attorneyCount>=2&&attorneyCount<=10&&!effectiveWebsite;
  const maxEmailRecoveryAttempts=sizeReadyForEmail?4:2;
  if((!emails.length||!emailSourceVerified)&&recoveryAttempts<maxEmailRecoveryAttempts){
    const recoverable={...enriched,email_recovery_attempts:recoveryAttempts+1,email_recovery_last_at:new Date().toISOString(),law_email_validation:"recovery_pending"};
    await redis.hSet(LEAD_HASH,key,JSON.stringify(recoverable));
    const retrySet=sizeReadyForEmail?SIZE_READY_PENDING_SET:RECOVERABLE_PENDING_SET;
    await Promise.all([
      redis.sRem(READY_SET,key),
      redis.sRem(UNIQUE_ELIGIBLE_SET,key),
      redis.sRem(REJECTED_SET,key),
      redis.sRem(ENRICHED_SET,key),
      redis.sAdd(retrySet,key)
    ]);
    await redis.hIncrBy(STATS,sizeReadyForEmail?"size_ready_email_requeued":"email_recovery_requeued",1);
    console.log(JSON.stringify({event:"law_email_recovery_requeued",key,name:String(lead.name||lead.title||""),attempt:recoveryAttempts+1,sizeReady:sizeReadyForEmail}));
    return true;
  }

  await redis.hSet(LEAD_HASH,key,JSON.stringify(enriched));
  await redis.sAdd(ENRICHED_SET,key);
  await redis.hIncrBy(STATS,"enriched",1);
  if(qualified){
    await redis.sAdd(UNIQUE_ELIGIBLE_SET,key);
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
    await Promise.all([redis.sRem(READY_SET,key),redis.sRem(UNIQUE_ELIGIBLE_SET,key)]);
    if(callReady){
      await redis.sRem(REJECTED_SET,key);
      await redis.hIncrBy(STATS,"call_ready_without_verified_email",1);
    }else{
      await redis.sAdd(REJECTED_SET,key);
      if(!attorneyCountVerified) await redis.hIncrBy(STATS,"rejected_unverified_attorney_count",1);
      else if(!preferredSize) await redis.hIncrBy(STATS,"rejected_wrong_size",1);
      else if(effectiveWebsite) await redis.hIncrBy(STATS,"rejected_has_website",1);
      else if(!isUsableLawPhone(lead.phone)) await redis.hIncrBy(STATS,"rejected_no_usable_phone",1);
      else if(!emails.length||!emailSourceVerified) await redis.hIncrBy(STATS,"rejected_no_verified_email",1);
    }
  }
  const rejectReason=qualified?"":callReady?"call_ready_email_optional":effectiveWebsite?"owned_website":!attorneyCountVerified?"unverified_attorney_count":!preferredSize?"wrong_size":!isUsableLawPhone(lead.phone)?"no_usable_phone":!emails.length||!emailSourceVerified?"no_verified_email":"other";
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
      if(blocked.test(host)||knownThirdPartyDirectoryHost(u.href)||lawSourceRank(u.href,lead)<=4)continue;
      if(!candidates.includes(u.origin))candidates.push(u.origin);
    }catch{}
  }
  return candidates[0]||"";
}
async function ownedWebsiteFromTrustedProfile(source="",lead={},key=""){
  if(!source||!trustedLawSource(source,lead))return "";
  try{
    const page=await fetchResearchPage(source,lead,key,true);
    if(!page?.html)return "";
    const html=String(page.html||"");
    const sourceHost=hostOf(page.final_url||source);
    const hrefs=[...html.matchAll(/href=["']([^"']+)["']/gi)].map(m=>String(m[1]||""));
    for(const href of hrefs.slice(0,80)){
      try{
        const u=new URL(href,page.final_url||source);
        const host=u.hostname.toLowerCase().replace(/^www\./,"");
        if(!/^https?:$/.test(u.protocol)||host===sourceHost||knownThirdPartyDirectoryHost(u.href)||lawSourceRank(u.href,lead)<=4)continue;
        const verified=await verifyOwnedWebsiteCandidate(u.origin,lead);
        if(verified)return verified;
      }catch{}
    }
  }catch{}
  return "";
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
  let scanned=0,qualifiedAdded=0,qualifiedRemoved=0,queuedForEnrichment=0,alreadyQualified=0,requalifyQueued=0,historicalQualifiedMarkers=0,calbarAdapterRecoveryQueued=0,chicagoHeadcountRecoveryQueued=0,associationDocketRecoveryQueued=0;
  const fullRequalify=(await redis.get(REQUALIFY_VERSION_KEY))!==FULL_REQUAL_VERSION;
  const historicalRecovery=(await redis.get(HISTORICAL_RECOVERY_VERSION_KEY))!==HISTORICAL_RECOVERY_VERSION;
  const calbarAdapterRecovery=(await redis.get(CALBAR_ADAPTER_VERSION_KEY))!==CALBAR_ADAPTER_VERSION;
  const floridaDirectRecovery=(await redis.get(FLORIDA_DIRECT_RECOVERY_KEY))!==FLORIDA_DIRECT_RECOVERY_VERSION;
  const candidateSizeRecovery=(await redis.get(CANDIDATE_SIZE_RESEARCH_VERSION_KEY))!==CANDIDATE_SIZE_RESEARCH_VERSION;
  const chicagoHeadcountRecovery=(await redis.get(CHICAGO_HEADCOUNT_RECOVERY_KEY))!==CHICAGO_HEADCOUNT_RECOVERY_VERSION;
  const associationDocketRecovery=(await redis.get(ASSOCIATION_DOCKET_RECOVERY_KEY))!==ASSOCIATION_DOCKET_RECOVERY_VERSION;
  const sizeReadyWebsiteAudit=(await redis.get(SIZE_READY_WEBSITE_AUDIT_KEY))!==SIZE_READY_WEBSITE_AUDIT_VERSION;
  const readySet=new Set(await redis.sMembers(READY_SET));
  const requalSizeReady=[],requalRegular=[],requalPriority=[],requalRecoverable=[],requalAll=[],floridaRecoveryKeys=[];

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
      if(floridaDirectRecovery&&isLaw&&floridaRecoveryKeys.length<300&&normalizedStateCode(lead)==="FL"&&
        !String(lead.website||lead.discovered_website||lead.owned_website||"").trim()&&
        lead.law_email_source_verified!==true){
        floridaRecoveryKeys.push(entry.field);
      }
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

      let bootstrapHeadcountValid=hasValidStoredHeadcount(lead);
      if(lead.attorney_count_evidence_verified===true&&!bootstrapHeadcountValid){
        const bootstrapEmails=[...(Array.isArray(lead.emails)?lead.emails:[]),lead.email]
          .map(x=>String(x||"").trim().toLowerCase()).filter(isUsableLawEmail);
        lead={...lead,attorney_count_evidence_verified:false,attorney_count_estimate:0,attorney_count_source:"",firm_size_tier:"unknown",preferred_firm_size:false,qualified_lead:false};
        await redis.hSet(LEAD_HASH,entry.field,JSON.stringify(lead));
        await redis.hDel(VERIFIED_HEADCOUNT_EVIDENCE_HASH,entry.field);
        await Promise.all([
          redis.sRem(UNIQUE_VERIFIED_HEADCOUNT_SET,entry.field),
          redis.sRem(UNIQUE_ELIGIBLE_SET,entry.field),
          redis.sRem(READY_SET,entry.field),
          redis.sRem(ENRICHED_SET,entry.field),
          redis.sRem(SIZE_READY_PENDING_SET,entry.field)
        ]);
        readySet.delete(entry.field);
        if(!website){
          await moveToEmailQueue(entry.field,bootstrapEmails.length?PENDING_SET:(highValueLawResearchLead(lead)?PRIORITY_PENDING_SET:RECOVERABLE_PENDING_SET));
          queuedForEnrichment++;
        }
        await redis.hIncrBy(STATS,"bootstrap_invalid_bar_headcount_cleared",1);
        bootstrapHeadcountValid=false;
      }

      if(sizeReadyWebsiteAudit&&!website&&bootstrapHeadcountValid){
        const n=Number(lead.attorney_count_estimate||0);
        if(n>=2&&n<=10){
          await Promise.all([
            redis.sRem(ENRICHED_SET,entry.field),
            redis.sRem(REJECTED_SET,entry.field),
            redis.sRem(PRIORITY_PENDING_SET,entry.field),
            redis.sRem(RECOVERABLE_PENDING_SET,entry.field),
            redis.sRem(SOURCE_PENDING_SET,entry.field),
            redis.sRem(PENDING_SET,entry.field)
          ]);
          await redis.sAdd(SIZE_READY_PENDING_SET,entry.field);
          queuedForEnrichment++;
        }
      }

      // Nationwide phone-first campaign: every callable no-site law record with
      // unknown headcount must be researched. Business-name shape is only a
      // ranking signal; verified headcount decides whether it is 2-10.
      if(!website &&
         isUsableLawPhone(lead.phone) &&
         lead.attorney_count_evidence_verified!==true){
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
        queuedForEnrichment++;
        await redis.hIncrBy(STATS,"phone_headcount_nationwide_queued",1);
        // Headcount is the missing gate. Skip startup email/MX work so the
        // phone-first lane can convert the existing inventory immediately.
        continue;
      }

      // One-time recovery for legacy Chicago records created before the
      // phone-first campaign. Re-open every callable no-site record whose
      // headcount is still unverified; verified size decides eligibility.
      if(chicagoHeadcountRecovery && !website &&
         /\bchicago\b/i.test(String(lead.acquisition_location||lead.target_area||"")) &&
         isUsableLawPhone(lead.phone) &&
         lead.attorney_count_evidence_verified!==true){
        await Promise.all([
          redis.sRem(ENRICHED_SET,entry.field),
          redis.sRem(REJECTED_SET,entry.field),
          redis.sRem(RECOVERABLE_PENDING_SET,entry.field),
          redis.sRem(SOURCE_PENDING_SET,entry.field),
          redis.sRem(SIZE_READY_PENDING_SET,entry.field),
          redis.sRem(PENDING_SET,entry.field)
        ]);
        await redis.sAdd(CHICAGO_PENDING_SET,entry.field);
        chicagoHeadcountRecoveryQueued++;
      }

      // One-time recovery for the association/court-record email adapter.
      // Re-open only no-website firm/multi-shaped records; obvious solos stay in
      // the cheap recovery lane and do not consume the high-value queue.
      if(associationDocketRecovery&&!website&&highValueLawResearchLead(lead)){
        await Promise.all([
          redis.sRem(ENRICHED_SET,entry.field),
          redis.sRem(REJECTED_SET,entry.field),
          redis.sRem(EMAIL_CANDIDATE_SET,entry.field),
          redis.sRem(RECOVERABLE_PENDING_SET,entry.field),
          redis.sRem(SOURCE_PENDING_SET,entry.field),
          redis.sRem(SIZE_READY_PENDING_SET,entry.field),
          redis.sRem(PENDING_SET,entry.field)
        ]);
        await redis.sAdd(PRIORITY_PENDING_SET,entry.field);
        associationDocketRecoveryQueued++;
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
      if(sourceBacked&&emails.length){
        await redis.sAdd(UNIQUE_VERIFIED_EMAIL_SET,entry.field);
        await redis.hSet(VERIFIED_EMAIL_EVIDENCE_HASH,entry.field,JSON.stringify({
          emails:[...new Set(emails)],
          source:existingSource,
          verified_at:String(lead.law_email_verified_at||lead.law_firm_enriched_at||new Date().toISOString()),
          verification:String(lead.law_email_validation||"published_exact+strict_firm_identity+mx")
        }));
      }else{
        try{
          const durableRaw=await redis.hGet(VERIFIED_EMAIL_EVIDENCE_HASH,entry.field);
          if(durableRaw){
            const durable=JSON.parse(durableRaw);
            if(Array.isArray(durable?.emails)&&durable.emails.length&&isDirectPublishedEmailSource(durable?.source||"")){
              await redis.sAdd(UNIQUE_VERIFIED_EMAIL_SET,entry.field);
            }
          }
        }catch{}
      }
      if(lead.attorney_count_evidence_verified===true&&attorneyCount>0){
        await redis.sAdd(UNIQUE_VERIFIED_HEADCOUNT_SET,entry.field);
        const hcSource=String(lead.attorney_count_source||"");
        if(isPublishedHeadcountSource(hcSource,lead)){
          await redis.hSet(VERIFIED_HEADCOUNT_EVIDENCE_HASH,entry.field,JSON.stringify({
            count:attorneyCount,
            source:hcSource,
            verified_at:String(lead.attorney_count_verified_at||lead.law_firm_enriched_at||new Date().toISOString()),
            verification:"published_identity_matched_headcount"
          }));
        }
      }
      const evidenceText=[lead.category,lead.name,lead.description,lead.descriptions].filter(Boolean).join(" ");
      const observedKeys=lawFirmPracticeKeys(evidenceText);
      const storedKeys=Array.isArray(lead.practice_keys)?lead.practice_keys:[];
      const focus=String(lead.practice_focus||"").trim();
      const practiceKeys=[...new Set([...storedKeys,...observedKeys,...(focus?[focus]:[])])];

      let effectiveWebsite=website;
      bootstrapHeadcountValid=hasValidStoredHeadcount(lead);
      const bootstrapSizeReady=bootstrapHeadcountValid&&Number(lead.attorney_count_estimate||0)>=2&&Number(lead.attorney_count_estimate||0)<=10;
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
        const sizeReady=hasValidStoredHeadcount(lead)&&Number(lead.attorney_count_estimate||0)>=2&&Number(lead.attorney_count_estimate||0)<=10;
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
        attorney_count_evidence_verified:bootstrapHeadcountValid,
        email_source_verified:sourceBacked&&emails.length>0
      });

      if(qualifies)await redis.sAdd(UNIQUE_ELIGIBLE_SET,entry.field);
      else await redis.sRem(UNIQUE_ELIGIBLE_SET,entry.field);

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

  if(floridaDirectRecovery&&floridaRecoveryKeys.length){
    for(let i=0;i<floridaRecoveryKeys.length;i+=250){
      const chunk=floridaRecoveryKeys.slice(i,i+250);
      await Promise.all([
        redis.sRem(ENRICHED_SET,chunk),
        redis.sRem(REJECTED_SET,chunk),
        redis.sRem(RECOVERABLE_PENDING_SET,chunk),
        redis.sRem(SOURCE_PENDING_SET,chunk),
        redis.sRem(SIZE_READY_PENDING_SET,chunk)
      ]);
      await redis.sAdd(PENDING_SET,chunk);
    }
    console.log(JSON.stringify({event:"law_florida_direct_recovery_queued",count:floridaRecoveryKeys.length,version:FLORIDA_DIRECT_RECOVERY_VERSION}));
  }
  if(floridaDirectRecovery)await redis.set(FLORIDA_DIRECT_RECOVERY_KEY,FLORIDA_DIRECT_RECOVERY_VERSION);

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
  if(associationDocketRecovery)await redis.set(ASSOCIATION_DOCKET_RECOVERY_KEY,ASSOCIATION_DOCKET_RECOVERY_VERSION);
  if(sizeReadyWebsiteAudit)await redis.set(SIZE_READY_WEBSITE_AUDIT_KEY,SIZE_READY_WEBSITE_AUDIT_VERSION);

  // READY_SET is revalidated record-by-record above. Keep the secondary
  // UNIQUE_ELIGIBLE_SET exactly aligned so monitoring/export counts cannot
  // retain stale leads after a website/size/email rejection.
  const validatedReady=[...readySet];
  await redis.del(UNIQUE_ELIGIBLE_SET);
  if(validatedReady.length){
    for(let i=0;i<validatedReady.length;i+=500){
      await redis.sAdd(UNIQUE_ELIGIBLE_SET,validatedReady.slice(i,i+500));
    }
  }

  console.log(JSON.stringify({
    event:"law_firm_bootstrap_existing",scanned,qualifiedAdded,qualifiedRemoved,alreadyQualified,FULL_REQUAL_VERSION,HISTORICAL_RECOVERY_VERSION,EMAIL_METHOD_VERSION,CALBAR_ADAPTER_VERSION,calbarAdapterRecoveryQueued,floridaDirectRecoveryQueued:floridaRecoveryKeys.length,chicagoHeadcountRecoveryQueued,associationDocketRecoveryQueued,
    queuedForEnrichment,requalifyQueued,fullRequalify,
    requalifySizeReady:requalSizeReady.length,requalifyRegular:requalRegular.length,requalifyPriority:requalPriority.length,requalifyRecoverable:requalRecoverable.length,
    historicalQualifiedMarkers
  }));
  return {scanned,qualifiedAdded,qualifiedRemoved,alreadyQualified,queuedForEnrichment,requalifyQueued};
}

async function popSetBatch(setKey,count){
  // node-redis v5 splits single-member and count variants into two methods:
  // sRandMember(key) returns ONE member; sRandMemberCount(key,count) returns
  // the requested batch. Using sRandMember(key,count) silently ignored count
  // and throttled every enrichment lane to one lead per queue per cycle.
  const requested=Math.max(1,Math.floor(Number(count)||1));
  const cardinality=await redis.sCard(setKey);
  if(cardinality<=0)return [];
  const target=Math.min(requested,cardinality);
  const members=await redis.sRandMemberCount(setKey,target);
  const values=Array.isArray(members)?members:(members?[members]:[]);
  const unique=[...new Set(values.filter(Boolean))].slice(0,target);
  if(unique.length<target){
    await redis.hIncrBy(STATS,"set_batch_short_read",1);
    console.warn(JSON.stringify({
      event:"law_set_batch_short_read",setKey,requested,target,cardinality,received:unique.length
    }));
  }
  return unique;
}
async function moveToEmailQueue(key,targetSet){
  await Promise.all([
    redis.sRem(PHONE_HEADCOUNT_PRIORITY_SET,key),
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
async function processEnrichKeys(keys=[],lane="general",concurrency=ENRICH_CONCURRENCY){
  const uniqueKeys=[...new Set(keys.filter(Boolean))];
  if(!uniqueKeys.length)return 0;
  let index=0,done=0,skippedForSizeReady=0;
  const run=async()=>{
    while(index<uniqueKeys.length){
      const key=uniqueKeys[index++];
      try{
        // The strict-conversion loop owns SIZE_READY_PENDING_SET. A general
        // batch that sampled a stale overlapping queue entry must yield rather
        // than race the same lead through two expensive research paths.
        if(lane!=="size_ready"&&await redis.sIsMember(SIZE_READY_PENDING_SET,key)){
          skippedForSizeReady++;
          continue;
        }
        const raw=await redis.hGet(LEAD_HASH,key);
        if(!raw)continue;
        let lead;try{lead=JSON.parse(raw)||{};}catch{continue;}
        const result=await enrichLead(key,lead);
        const finalRaw=await redis.hGet(LEAD_HASH,key);
        let finalLead={};try{finalLead=finalRaw?JSON.parse(finalRaw):{};}catch{}
        const retryPending=String(finalLead.law_email_validation||"")==="recovery_pending";
        const finalWebsite=String(finalLead.website||finalLead.website_url||"").trim();
        const finalCount=Number(finalLead.attorney_count_estimate||finalLead.attorney_count||0);
        const finalSizeReady=finalLead.attorney_count_evidence_verified===true&&finalCount>=2&&finalCount<=10&&!/^https?:\/\//i.test(finalWebsite);
        await Promise.all([
          redis.sRem(PHONE_HEADCOUNT_PRIORITY_SET,key),
          redis.sRem(CHICAGO_PENDING_SET,key),
          redis.sRem(SOURCE_PENDING_SET,key),
          redis.sRem(SIZE_READY_PENDING_SET,key),
          redis.sRem(RECOVERABLE_PENDING_SET,key),
          redis.sRem(PRIORITY_PENDING_SET,key),
          redis.sRem(PENDING_SET,key)
        ]);
        if(retryPending){
          await redis.sAdd(finalSizeReady?SIZE_READY_PENDING_SET:RECOVERABLE_PENDING_SET,key);
        }
        if(result)done++;
      }catch(error){
        const rawRetry=await redis.hGet(LEAD_HASH,key);
        let retryLead={};try{retryLead=rawRetry?JSON.parse(rawRetry):{};}catch{}
        const retryWebsite=String(retryLead.website||retryLead.website_url||"").trim();
        const retryCount=Number(retryLead.attorney_count_estimate||retryLead.attorney_count||0);
        const retrySizeReady=retryLead.attorney_count_evidence_verified===true&&retryCount>=2&&retryCount<=10&&!/^https?:\/\//i.test(retryWebsite);
        const needsPhoneHeadcount=!/^https?:\/\//i.test(retryWebsite)&&isUsableLawPhone(retryLead.phone)&&retryLead.attorney_count_evidence_verified!==true;
        if(retrySizeReady){
          await redis.sAdd(SIZE_READY_PENDING_SET,key);
        }else if(needsPhoneHeadcount){
          const shape=lawFirmNameShape(retryLead);
          await redis.sAdd((shape==="multi"||shape==="firm")?PHONE_HEADCOUNT_PRIORITY_SET:CHICAGO_PENDING_SET,key);
        }else{
          const retryEmails=[...(Array.isArray(retryLead.emails)?retryLead.emails:[]),retryLead.email].filter(isUsableLawEmail);
          const retrySet=retryEmails.length?PENDING_SET:(emailRecoveryPriority(retryLead)>=3?RECOVERABLE_PENDING_SET:PRIORITY_PENDING_SET);
          await moveToEmailQueue(key,retrySet);
        }
        console.warn(JSON.stringify({event:"law_firm_enrich_retry",lane,key,error:String(error?.message||error)}));
      }
    }
  };
  await Promise.all(Array.from({length:Math.min(concurrency,uniqueKeys.length)},()=>run()));
  if(skippedForSizeReady)await redis.hIncrBy(STATS,"general_enrich_yielded_to_size_ready",skippedForSizeReady);
  return done;
}

async function enrichSizeReadyBatch(){
  // External legal/search sources degrade sharply when the strict-email lane
  // and the headcount lane both run at their configured maximum. Keep the
  // strict lane wide, but below the observed saturation point so requests
  // finish instead of accumulating into multi-minute stalls.
  const strictBatch=Math.min(SIZE_READY_EMAIL_BATCH,64);
  const strictConcurrency=Math.min(SIZE_READY_EMAIL_CONCURRENCY,32);
  const keys=await popSetBatch(SIZE_READY_PENDING_SET,strictBatch);
  if(!keys.length)return 0;
  console.log(JSON.stringify({
    event:"law_size_ready_batch_selected",
    total:keys.length,
    concurrency:strictConcurrency,
    configuredBatch:SIZE_READY_EMAIL_BATCH,
    configuredConcurrency:SIZE_READY_EMAIL_CONCURRENCY
  }));
  await redis.hIncrBy(STATS,"size_ready_batch_selected",keys.length);
  return processEnrichKeys(keys,"size_ready",strictConcurrency);
}

async function enrichBatch(){
  // General worker: prove size and recover non-size-ready evidence. When the
  // strict 2-10/no-site email backlog exists, reserve network capacity for that
  // final eligibility gate instead of running 80 headcount workers beside it.
  const sizeReadyBacklog=await redis.sCard(SIZE_READY_PENDING_SET);
  const strictPressure=sizeReadyBacklog>0;
  const generalBudget=strictPressure?Math.min(64,ENRICH_BATCH):ENRICH_BATCH;
  const generalConcurrency=strictPressure?Math.min(16,ENRICH_CONCURRENCY):ENRICH_CONCURRENCY;

  const regularKeys=await popSetBatch(PENDING_SET,Math.min(16,generalBudget));
  const afterRegular=Math.max(0,generalBudget-regularKeys.length);

  const phonePriorityTarget=Math.min(afterRegular,Math.max(16,Math.floor(generalBudget*0.55)));
  const phonePriorityKeys=afterRegular?await popSetBatch(PHONE_HEADCOUNT_PRIORITY_SET,phonePriorityTarget):[];
  const afterPhonePriority=Math.max(0,afterRegular-phonePriorityKeys.length);

  // While the phone/headcount backlog exists, use every remaining general slot
  // to prove firm size. Email recovery for proven 2-10 firms already has its
  // own SIZE_READY worker; spending ~35% of this worker on generic email
  // recovery was starving the only lane capable of creating more 2-10 firms.
  const chicagoTarget=afterPhonePriority;
  const chicagoKeys=afterPhonePriority?await popSetBatch(CHICAGO_PENDING_SET,chicagoTarget):[];
  const afterChicago=Math.max(0,afterPhonePriority-chicagoKeys.length);

  const freshKeys=afterChicago?await popSetBatch(SOURCE_PENDING_SET,Math.min(8,afterChicago)):[];
  const afterFresh=Math.max(0,afterChicago-freshKeys.length);
  const priorityKeys=afterFresh?await popSetBatch(PRIORITY_PENDING_SET,Math.min(12,afterFresh)):[];
  const afterPriority=Math.max(0,afterFresh-priorityKeys.length);
  const recoverableKeys=afterPriority?await popSetBatch(RECOVERABLE_PENDING_SET,afterPriority):[];
  const keys=[...new Set([...regularKeys,...phonePriorityKeys,...chicagoKeys,...freshKeys,...priorityKeys,...recoverableKeys])].slice(0,generalBudget);
  if(!keys.length)return 0;
  console.log(JSON.stringify({
    event:"law_enrich_batch_selected",
    lane:"general",
    regular:regularKeys.length,
    phonePriority:phonePriorityKeys.length,
    phonePending:chicagoKeys.length,
    fresh:freshKeys.length,
    priority:priorityKeys.length,
    recoverable:recoverableKeys.length,
    total:keys.length,
    concurrency:generalConcurrency,
    strictPressure,
    sizeReadyBacklog,
    configuredBatch:ENRICH_BATCH,
    configuredConcurrency:ENRICH_CONCURRENCY
  }));
  await redis.hIncrBy(STATS,"enrich_non_destructive_batch_selected",keys.length);
  if(strictPressure)await redis.hIncrBy(STATS,"general_backpressure_for_size_ready",keys.length);
  return processEnrichKeys(keys,"general",generalConcurrency);
}

const LAWYERS_STATE_SLUGS={
  AL:"alabama",AK:"alaska",AZ:"arizona",AR:"arkansas",CA:"california",CO:"colorado",CT:"connecticut",DE:"delaware",FL:"florida",GA:"georgia",
  HI:"hawaii",ID:"idaho",IL:"illinois",IN:"indiana",IA:"iowa",KS:"kansas",KY:"kentucky",LA:"louisiana",ME:"maine",MD:"maryland",MA:"massachusetts",
  MI:"michigan",MN:"minnesota",MS:"mississippi",MO:"missouri",MT:"montana",NE:"nebraska",NV:"nevada",NH:"new-hampshire",NJ:"new-jersey",NM:"new-mexico",
  NY:"new-york",NC:"north-carolina",ND:"north-dakota",OH:"ohio",OK:"oklahoma",OR:"oregon",PA:"pennsylvania",RI:"rhode-island",SC:"south-carolina",
  SD:"south-dakota",TN:"tennessee",TX:"texas",UT:"utah",VT:"vermont",VA:"virginia",WA:"washington",WV:"west-virginia",WI:"wisconsin",WY:"wyoming"
};

function lawyersComCityUrl(area={},page=1){
  const city=normalize(String(area.city||"")).replace(/\s+/g,"-");
  const state=LAWYERS_STATE_SLUGS[String(area.state||"").toUpperCase()]||"";
  if(!city||!state)return "";
  const base=`https://www.lawyers.com/all-legal-issues/${city}/${state}/law-firms/`;
  return page>1?`${base}?page=${page}`:base;
}

function absoluteLawyersUrl(href=""){
  try{
    const u=new URL(String(href||""),"https://www.lawyers.com");
    if(!/(^|\.)lawyers\.com$/i.test(u.hostname))return "";
    return u.href;
  }catch{return "";}
}

function extractDirectoryPhone(text=""){
  const raw=String(text||"");
  const matches=[...raw.matchAll(/(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]\d{3}[\s.-]\d{4}/g)]
    .map(m=>String(m[0]||"").trim());
  return matches.find(isUsableLawPhone)||"";
}

function directoryCardWebsiteCandidate(block="",profileUrl=""){
  const raw=String(block||"");
  for(const m of raw.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi)){
    const label=stripHtml(String(m[2]||"")).replace(/\s+/g," ").trim();
    if(!/^(?:visit\s+)?website$/i.test(label))continue;
    try{
      const u=new URL(String(m[1]||""),profileUrl||"https://www.lawyers.com");
      const host=hostOf(u.href);
      if(!/^https?:$/.test(u.protocol)||!host)continue;
      if(/(^|\.)lawyers\.com$/i.test(host))continue;
      if(knownThirdPartyDirectoryHost(u.href))continue;
      return u.href;
    }catch{}
  }
  return "";
}

function directoryCardFirmAnchor(beforeHtml=""){
  const raw=String(beforeHtml||"");
  const candidates=[];
  for(const m of raw.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]{1,500}?)<\/a>/gi)){
    candidates.push({href:m[1],name:stripHtml(String(m[2]||"")),index:m.index||0});
  }
  // Jina Reader returns markdown. Lawyers.com firm cards preserve their firm-profile links.
  for(const m of raw.matchAll(/\[([^\]]{2,180})\]\((https?:\/\/[^)\s]+)\)/g)){
    candidates.push({href:m[2],name:String(m[1]||""),index:m.index||0});
  }
  candidates.sort((a,b)=>a.index-b.index);
  for(let i=candidates.length-1;i>=0;i--){
    const href=absoluteLawyersUrl(candidates[i].href);
    if(!href||!/-f\/?(?:[?#].*)?$/i.test(href))continue;
    const name=stripHtml(String(candidates[i].name||"")).replace(/\s+/g," ").trim();
    if(!name||name.length<3||name.length>180)continue;
    return {href,name,index:candidates[i].index||0};
  }
  return null;
}

function extractLawyersComDirectoryCandidates(html="",sourceUrl="",area={}){
  const raw=String(html||"");
  const sizeMatches=[...raw.matchAll(/\bLaw\s+(?:Firm|Office)\s+with\s+(\d{1,2})\s+lawyers?\b/gi)];
  const out=[];
  const seen=new Set();
  for(let j=0;j<sizeMatches.length;j++){
    const n=Number(sizeMatches[j][1]||0);
    if(n<2||n>10)continue;
    const sizeIndex=sizeMatches[j].index||0;
    const nextIndex=j+1<sizeMatches.length?(sizeMatches[j+1].index||raw.length):Math.min(raw.length,sizeIndex+12000);
    const beforeStart=Math.max(0,sizeIndex-9000);
    const before=raw.slice(beforeStart,sizeIndex);
    const anchor=directoryCardFirmAnchor(before);
    if(!anchor)continue;

    const profileUrl=anchor.href;
    const name=anchor.name;
    const blockStart=Math.max(beforeStart,beforeStart+anchor.index);
    const block=raw.slice(blockStart,Math.min(raw.length,nextIndex));
    const plain=stripHtml(block).replace(/\s+/g," ").trim();

    // Do not discard a firm merely because the directory renders a Website
    // action. Tracking/alias links can be false positives. Preserve the
    // candidate and verify ownership against firm identity later.
    const websiteCandidate=directoryCardWebsiteCandidate(block,profileUrl);

    const phone=extractDirectoryPhone(plain);
    if(!phone)continue;
    const phoneKey=normalizeLawPhone(phone);
    if(!phoneKey)continue;

    const addrMatch=plain.match(/\b\d{1,6}\s+[A-Za-z0-9.'’#\- ]{3,120},\s*[A-Za-z.'’\- ]{2,60},\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/);
    const address=String(addrMatch?.[0]||"").trim();
    const key=phoneKey+"|"+normalize(name);
    if(seen.has(key))continue;
    seen.add(key);
    out.push({
      name,phone,address,
      city:String(area.city||""),state:String(area.state||"").toUpperCase(),
      attorneyCount:n,profileUrl,listingUrl:sourceUrl,websiteCandidate
    });
  }
  return out;
}

async function verifyDirectoryCandidate(candidate={}){
  try{
    const seedLead={
      name:candidate.name,phone:candidate.phone,address:candidate.address,
      city:candidate.city,region:candidate.state,state:candidate.state,
      industry:"LAW_FIRM",search_profile:"law-firm",website:"",
      conversion_headcount_priority:true
    };
    let page=null;
    try{page=await fetchText(candidate.profileUrl,6000);}catch{}
    if(!page?.html){
      try{page=await callJinaReader(candidate.profileUrl,seedLead);}catch{}
    }
    if(!page?.html){
      try{page=await callScrapling(candidate.profileUrl,{allowBrowser:false});}catch{}
    }
    if(!page?.html)return null;
    const source=String(page.final_url||candidate.profileUrl);
    if(!/(^|\.)lawyers\.com$/i.test(hostOf(source)))return null;
    const text=stripHtml(page.html).slice(0,100000);
    const normText=normalize(text);
    const fullName=normalize(candidate.name);
    const exactNameMatch=Boolean(fullName.length>=6&&normText.includes(fullName));
    const htmlIdentity=strictDirectoryFirmIdentity(page.html,source,seedLead);
    if(!htmlIdentity&&!exactNameMatch)return null;

    const phoneDigits=normalizeLawPhone(candidate.phone);
    const profilePhoneMatch=Boolean(phoneDigits&&String(text).replace(/\D/g,"").includes(phoneDigits));
    const profileCount=officialFirmSizeEstimate(text);
    const attorneyNames=page.via==="jina"?[]:strictFirmPageRosterNames(page.html,source,seedLead);
    const rosterCount=page.via==="jina"?0:(attorneyNames.length>10?11:attorneyNames.length);
    const count=profileCount>0?profileCount:rosterCount;
    if(count<2||count>10)return null;

    // The city listing and dedicated profile are independent pages on the same
    // legal directory. Require exact phone OR exact agreement on the published size.
    if(!profilePhoneMatch&&count!==Number(candidate.attorneyCount||0))return null;

    if(candidate.websiteCandidate){
      const verifiedListingWebsite=await verifyOwnedWebsiteCandidate(candidate.websiteCandidate,seedLead);
      if(verifiedListingWebsite){
        return {...candidate,rejectWebsite:verifiedListingWebsite,count,source,attorneyNames};
      }
    }

    if(page.via!=="jina"){
      const profileWebsite=outboundFirmWebsiteFromDirectory(page.html,seedLead);
      if(profileWebsite){
        const verifiedWebsite=await verifyOwnedWebsiteCandidate(profileWebsite,seedLead);
        if(verifiedWebsite)return {...candidate,rejectWebsite:verifiedWebsite,count,source,attorneyNames};
      }
    }

    // Zero-extra-fetch win: some legal-directory profiles publish a direct
    // mailbox. The profile has already passed strict firm identity + phone/size
    // checks, so keep only contextual, non-directory addresses with valid MX.
    const profileEmailCandidates=contextualEmails(page.html,seedLead,source);
    const emailChecks=await Promise.all(profileEmailCandidates.slice(0,5).map(async email=>({
      email,ok:await hasMailExchange(email)
    })));
    const publishedEmails=emailChecks.filter(x=>x.ok).map(x=>x.email);
    if(publishedEmails.length){
      await redis.hIncrBy(STATS,"directory_profile_email_hit",1);
      console.log(JSON.stringify({
        event:"law_directory_profile_email_hit",
        name:String(candidate.name||""),source,
        emails:publishedEmails.slice(0,3),attorneys:count
      }));
    }
    return {...candidate,count,source,profilePhoneMatch,profileVia:String(page.via||"direct"),attorneyNames,publishedEmails};
  }catch{return null;}
}

async function persistDirectorySeed(candidate={}){
  const phone=normalizeLawPhone(candidate.phone);
  if(!phone||!candidate.source||candidate.count<2||candidate.count>10)return {added:false,reason:"invalid"};
  const existingKey=String(await redis.hGet("recover:leadstore:phone-index",phone)||"").trim();
  const key=existingKey||("phone:"+phone);
  let existing={};
  try{
    const raw=await redis.hGet(LEAD_HASH,key);
    if(raw)existing=JSON.parse(raw)||{};
  }catch{}

  if(candidate.rejectWebsite){
    const rejected={...existing,
      name:existing.name||candidate.name,
      phone:existing.phone||candidate.phone,
      address:existing.address||candidate.address,
      city:existing.city||candidate.city,
      region:existing.region||candidate.state,
      state:existing.state||candidate.state,
      industry:"LAW_FIRM",search_profile:"law-firm",
      website:candidate.rejectWebsite,
      attorney_count_estimate:candidate.count,
      attorney_count_evidence_verified:true,
      attorney_count_source:candidate.source,
      attorney_count_verified_at:new Date().toISOString(),
      headcount_identity_version:HEADCOUNT_IDENTITY_VERSION,
      preferred_firm_size:true,
      law_directory_seed_source:candidate.listingUrl
    };
    await redis.hSet(LEAD_HASH,key,JSON.stringify(rejected));
    await redis.hSet("recover:leadstore:phone-index",phone,key);
    await redis.sAdd(REJECTED_SET,key);
    await Promise.all([redis.sRem(SIZE_READY_PENDING_SET,key),redis.sRem(CALL_READY_SET,key),redis.sRem(READY_SET,key),redis.sRem(UNIQUE_ELIGIBLE_SET,key)]);
    return {added:false,reason:"owned_website"};
  }

  const now=new Date().toISOString();
  const lead={...existing,
    name:existing.name||candidate.name,
    phone:existing.phone||candidate.phone,
    address:existing.address||candidate.address,
    city:existing.city||candidate.city,
    region:existing.region||candidate.state,
    state:existing.state||candidate.state,
    industry:"LAW_FIRM",search_profile:"law-firm",
    acquisition_location:existing.acquisition_location||[candidate.city,candidate.state].filter(Boolean).join(", "),
    website:"",
    attorney_count_estimate:candidate.count,
    attorney_count_evidence_verified:true,
    attorney_count_source:candidate.source,
    attorney_count_verified_at:now,
    headcount_identity_version:HEADCOUNT_IDENTITY_VERSION,
    phone_headcount_status:"verified",
    phone_headcount_method_version:PHONE_HEADCOUNT_METHOD_VERSION,
    preferred_firm_size:true,
    firm_size_tier:"preferred_2_10",
    law_directory_seed_source:candidate.listingUrl,
    law_directory_seeded_at:now,
    directory_attorney_names:[...new Set([
      ...(Array.isArray(existing.directory_attorney_names)?existing.directory_attorney_names:[]),
      ...(Array.isArray(candidate.attorneyNames)?candidate.attorneyNames:[])
    ])].slice(0,10),
    conversion_headcount_priority:true,
    ...(Array.isArray(candidate.publishedEmails)&&candidate.publishedEmails.length?{
      emails:[...new Set([
        ...(Array.isArray(existing.emails)?existing.emails:[]),
        ...candidate.publishedEmails
      ])],
      email:candidate.publishedEmails[0],
      law_email_source:candidate.source,
      law_email_source_verified:true,
      law_email_validation:"published_exact+strict_firm_identity+mx",
      law_email_verified_at:now
    }:{})
  };

  const profileEmails=Array.isArray(candidate.publishedEmails)?candidate.publishedEmails:[];
  await Promise.all([
    redis.hSet(LEAD_HASH,key,JSON.stringify(lead)),
    redis.hSet("recover:leadstore:phone-index",phone,key),
    redis.hSet(VERIFIED_HEADCOUNT_EVIDENCE_HASH,key,JSON.stringify({
      count:candidate.count,source:candidate.source,verified_at:now,
      verification:"lawyerscom_profile_size+"+HEADCOUNT_IDENTITY_VERSION
    })),
    ...(profileEmails.length?[
      redis.hSet(VERIFIED_EMAIL_EVIDENCE_HASH,key,JSON.stringify({
        emails:[...new Set(profileEmails)],
        source:candidate.source,
        verified_at:now,
        verification:"published_exact+strict_firm_identity+mx"
      })),
      redis.sAdd(UNIQUE_VERIFIED_EMAIL_SET,key)
    ]:[]),
    redis.sAdd(UNIQUE_VERIFIED_HEADCOUNT_SET,key),
    redis.sAdd(SIZE_READY_PENDING_SET,key),
    redis.sAdd(SCOPE_SET,key),
    redis.sRem(REJECTED_SET,key),
    redis.sRem(ENRICHED_SET,key),
    redis.sRem(PHONE_HEADCOUNT_PRIORITY_SET,key),
    redis.sRem(CHICAGO_PENDING_SET,key)
  ]);
  return {added:true,key};
}

async function seedLawyersComDirectory(cities=[]){
  if(!DIRECTORY_DISCOVERY_ENABLED||!cities.length)return {cities:0,candidates:0,verified:0,added:0,ownedWebsite:0};
  let cursor=Math.max(0,Number(await redis.get(DIRECTORY_CURSOR_KEY)||0));
  let citiesDone=0,candidatesFound=0,verified=0,added=0,ownedWebsite=0,fetchErrors=0,directPages=0,jinaPages=0,scraplingPages=0;

  for(let slot=0;slot<DIRECTORY_DISCOVERY_BATCH;slot++){
    let area=null,areaSeedKey="",guard=0;
    while(guard<cities.length){
      if(cursor>=cities.length)cursor=0;
      const candidateArea=cities[cursor++];
      guard++;
      const seedKey=String(candidateArea.state||"")+"|"+normalize(candidateArea.city||"");
      if(await redis.sIsMember(DIRECTORY_SEEDED_SET,seedKey))continue;
      area=candidateArea;
      areaSeedKey=seedKey;
      break;
    }
    if(!area){
      await redis.hIncrBy(STATS,"directory_coverage_exhausted",1);
      console.log(JSON.stringify({event:"law_directory_coverage_exhausted",cursor,cities:cities.length}));
      break;
    }
    citiesDone++;

    const pageTasks=[];
    for(let page=1;page<=DIRECTORY_DISCOVERY_PAGES;page++){
      const url=lawyersComCityUrl(area,page);
      if(url)pageTasks.push((async()=>{
        const areaLead={
          name:String(area.city||"")+" law firms",
          city:String(area.city||""),region:String(area.state||""),state:String(area.state||""),
          industry:"LAW_FIRM",search_profile:"law-firm",conversion_headcount_priority:true
        };
        const hasDirectoryRows=html=>/Law\s+(?:Firm|Office)\s+with\s+\d{1,2}\s+lawyers?/i.test(String(html||""));
        try{
          const direct=await fetchText(url,6000);
          if(direct?.html&&hasDirectoryRows(direct.html))return {url,html:String(direct.html),via:"direct"};
        }catch{}
        try{
          const jina=await callJinaReader(url,areaLead);
          if(jina?.html&&hasDirectoryRows(jina.html))return {url,html:String(jina.html),via:"jina"};
        }catch{}
        try{
          // Only pay for a browser fallback when the cheap readers returned a
          // shell/challenge page without actual firm rows.
          const scrap=await callScrapling(url,{allowBrowser:true});
          if(scrap?.html&&hasDirectoryRows(scrap.html))return {url,html:String(scrap.html),via:"scrapling"};
        }catch{}
        return {url,html:"",error:true};
      })());
    }
    let pages=await Promise.all(pageTasks);

    // Productive cities get a deeper pass immediately. This concentrates
    // source-first acquisition where the directory is already proving 2-10
    // firms instead of spending equal time on empty/sparse markets.
    if(DIRECTORY_DISCOVERY_MAX_PAGES>DIRECTORY_DISCOVERY_PAGES){
      const firstWaveCandidates=pages.flatMap(page=>page?.html?extractLawyersComDirectoryCandidates(page.html,page.url,area):[]);
      if(firstWaveCandidates.length>=6){
        const extraTasks=[];
        for(let page=DIRECTORY_DISCOVERY_PAGES+1;page<=DIRECTORY_DISCOVERY_MAX_PAGES;page++){
          const url=lawyersComCityUrl(area,page);
          if(!url)continue;
          extraTasks.push((async()=>{
            const areaLead={
              name:String(area.city||"")+" law firms",
              city:String(area.city||""),region:String(area.state||""),state:String(area.state||""),
              industry:"LAW_FIRM",search_profile:"law-firm",conversion_headcount_priority:true
            };
            const hasDirectoryRows=html=>/Law\s+(?:Firm|Office)\s+with\s+\d{1,2}\s+lawyers?/i.test(String(html||""));
            try{
              const direct=await fetchText(url,6000);
              if(direct?.html&&hasDirectoryRows(direct.html))return {url,html:String(direct.html),via:"direct"};
            }catch{}
            try{
              const jina=await callJinaReader(url,areaLead);
              if(jina?.html&&hasDirectoryRows(jina.html))return {url,html:String(jina.html),via:"jina"};
            }catch{}
            try{
              const scrap=await callScrapling(url,{allowBrowser:true});
              if(scrap?.html&&hasDirectoryRows(scrap.html))return {url,html:String(scrap.html),via:"scrapling"};
            }catch{}
            return {url,html:"",error:true};
          })());
        }
        if(extraTasks.length){
          const extraPages=await Promise.all(extraTasks);
          pages=[...pages,...extraPages];
          await redis.hIncrBy(STATS,"directory_productive_city_deepened",1);
        }
      }
    }
    // Only mark coverage complete after at least one real directory page was
    // fetched. Temporary blocks/timeouts must not permanently burn a city.
    if(areaSeedKey&&pages.some(page=>!page.error&&page.html)){
      await redis.sAdd(DIRECTORY_SEEDED_SET,areaSeedKey);
    }

    const rawCandidates=[];
    const pageVia={direct:0,jina:0,scrapling:0};
    for(const page of pages){
      if(page.error||!page.html){fetchErrors++;continue;}
      if(page.via)pageVia[page.via]=(pageVia[page.via]||0)+1;
      rawCandidates.push(...extractLawyersComDirectoryCandidates(page.html,page.url,area));
    }
    directPages+=pageVia.direct||0;jinaPages+=pageVia.jina||0;scraplingPages+=pageVia.scrapling||0;
    if(!rawCandidates.length){
      const diagnosticPage=pages.find(page=>page?.html);
      if(diagnosticPage){
        const raw=String(diagnosticPage.html);
        const m=/Law\s+(?:Firm|Office)\s+with\s+\d{1,2}\s+lawyers?/i.exec(raw);
        const idx=m?.index||0;
        console.log(JSON.stringify({
          event:"law_directory_parse_diagnostic",
          url:diagnosticPage.url,via:diagnosticPage.via||"",
          hasSizePhrase:Boolean(m),
          chars:raw.length,
          excerpt:raw.slice(Math.max(0,idx-400),Math.min(raw.length,idx+1400)).replace(/\s+/g," ").slice(0,1800)
        }));
      }
    }
    const byPhone=new Map();
    for(const item of rawCandidates){
      const phone=normalizeLawPhone(item.phone);
      if(phone&&!byPhone.has(phone))byPhone.set(phone,item);
    }
    const unique=[...byPhone.values()];
    candidatesFound+=unique.length;

    const checks=await Promise.allSettled(unique.slice(0,40).map(verifyDirectoryCandidate));
    for(const check of checks){
      if(check.status!=="fulfilled"||!check.value)continue;
      verified++;
      if(check.value.rejectWebsite)ownedWebsite++;
      const result=await persistDirectorySeed(check.value);
      if(result.added)added++;
    }
  }

  await redis.set(DIRECTORY_CURSOR_KEY,String(cursor));
  if(citiesDone||added||fetchErrors){
    console.log(JSON.stringify({
      event:"law_directory_seed_cycle",cities:citiesDone,candidates:candidatesFound,
      verified,added,ownedWebsite,fetchErrors,directPages,jinaPages,scraplingPages,cursor
    }));
  }
  if(added)await redis.hIncrBy(STATS,"directory_source_first_added",added);
  if(verified)await redis.hIncrBy(STATS,"directory_source_first_verified",verified);
  return {cities:citiesDone,candidates:candidatesFound,verified,added,ownedWebsite,fetchErrors};
}

async function directorySeedLoop(){
  while(true){
    try{await seedLawyersComDirectory(cities);}
    catch(error){console.error("law_directory_seed_error",error?.stack||error?.message||error);}
    await sleep(Math.max(1800,LOOP_MS));
  }
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
  const [queue,pendingPriority,pendingSource,pendingSizeReady,pendingRegular,pendingRecoverable,phonePriority,phonePending]=await Promise.all([
    redis.lLen(ACTIVE_QUEUE),
    redis.sCard(PRIORITY_PENDING_SET),
    redis.sCard(SOURCE_PENDING_SET),
    redis.sCard(SIZE_READY_PENDING_SET),
    redis.sCard(PENDING_SET),
    redis.sCard(RECOVERABLE_PENDING_SET),
    redis.sCard(PHONE_HEADCOUNT_PRIORITY_SET),
    redis.sCard(CHICAGO_PENDING_SET)
  ]);
  if(queue>=QUEUE_HIGH_WATER)return 0;
  const phoneBacklog=phonePriority+phonePending;
  // Generic Maps acquisition already has far more raw work than the strict
  // funnel can convert. Stop creating low-information records while thousands
  // still need headcount proof or while a meaningful 2-10 cohort is waiting on
  // the mandatory email gate. Directory-first discovery continues separately.
  if(phoneBacklog>=5000||pendingSizeReady>=100){
    await redis.hIncrBy(STATS,"generic_discovery_paused_for_strict_backlog",1);
    return 0;
  }
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
      partition_state:area.state,partition_city:area.city,source_population:area.population,target:40,min_score:45,
      require_phone:true,require_email:false,require_contact:true,require_no_website:true,include_no_website:true,
      max_rounds:1,depth:8,status:"queued",phase:"queued",round:0,rounds_completed:0,raw_count:0,unique_count:0,
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


async function bootstrapPhoneFirstInventory(){
  let scanned=0,callableNoSite=0,queuedHeadcount=0,seededCallReady=0,wrongSizeKnown=0,verifiedSolo=0,verifiedTarget=0,verifiedOversize=0;
  const callableByState=new Map(),priorityByState=new Map();
  const pendingChunk=[],priorityChunk=[],readyChunk=[],sizeReadyEmailChunk=[];
  await Promise.all([redis.del(CALL_READY_SET),redis.del(PHONE_HEADCOUNT_PRIORITY_SET),redis.del(CHICAGO_PENDING_SET)]);

  const flush=async()=>{
    if(priorityChunk.length){
      await redis.sAdd(PHONE_HEADCOUNT_PRIORITY_SET,[...priorityChunk]);
      queuedHeadcount+=priorityChunk.length;
      priorityChunk.length=0;
    }
    if(pendingChunk.length){
      await redis.sAdd(CHICAGO_PENDING_SET,[...pendingChunk]);
      queuedHeadcount+=pendingChunk.length;
      pendingChunk.length=0;
    }
    if(readyChunk.length){
      await redis.sAdd(CALL_READY_SET,[...readyChunk]);
      seededCallReady+=readyChunk.length;
      readyChunk.length=0;
    }
    if(sizeReadyEmailChunk.length){
      await redis.sAdd(SIZE_READY_PENDING_SET,[...sizeReadyEmailChunk]);
      sizeReadyEmailChunk.length=0;
    }
  };

  for await(const page of redis.hScanIterator(LEAD_HASH,{COUNT:1500})){
    for(const entry of (Array.isArray(page)?page:[page])){
      if(!entry?.field||entry.value===undefined)continue;
      scanned++;
      let lead;try{lead=JSON.parse(entry.value)||{};}catch{continue;}
      const isLaw=(String(lead.search_profile||"")==="law-firm"||normalize(lead.industry)==="law firm")&&isLawFirmLead(lead);
      if(!isLaw)continue;

      const website=String(lead.website||lead.website_url||lead.discovered_website||lead.owned_website||"").trim();
      if(/^https?:\/\//i.test(website))continue;
      if(!isUsableLawPhone(lead.phone))continue;
      callableNoSite++;
      const stateCode=String(normalizedStateCode(lead)||lead.region||lead.state||"").toUpperCase().trim()||"UNKNOWN";
      callableByState.set(stateCode,(callableByState.get(stateCode)||0)+1);

      const n=Number(lead.attorney_count_estimate||lead.attorney_count||0);
      const source=String(lead.attorney_count_source||"");
      const staleDirectoryEvidence=
        lead.attorney_count_evidence_verified===true &&
        n>0 &&
        headcountSourceNeedsV2Identity(source) &&
        String(lead.headcount_identity_version||"")!==HEADCOUNT_IDENTITY_VERSION;
      const verified=hasValidStoredHeadcount(lead);
      if(staleDirectoryEvidence){
        // Re-open directory-derived counts produced before fetched-page-only
        // verification. Preserve contact/email evidence, but force firm size
        // through the corrected source-page identity gate.
        lead={...lead,
          attorney_count_evidence_verified:false,
          attorney_count_estimate:0,
          attorney_count_source:"",
          headcount_identity_version:"",
          preferred_firm_size:false,
          firm_size_tier:"unknown",
          qualified_lead:false,
          call_ready_lead:false,
          phone_headcount_status:"needs_revalidation"
        };
        await redis.hSet(LEAD_HASH,entry.field,JSON.stringify(lead));
        await Promise.all([
          redis.sRem(UNIQUE_VERIFIED_HEADCOUNT_SET,entry.field),
          redis.sRem(UNIQUE_ELIGIBLE_SET,entry.field),
          redis.sRem(READY_SET,entry.field),
          redis.sRem(ENRICHED_SET,entry.field),
          redis.sRem(REJECTED_SET,entry.field)
        ]);
        await redis.hDel(VERIFIED_HEADCOUNT_EVIDENCE_HASH,entry.field);
        await redis.hIncrBy(STATS,"legacy_directory_headcount_reopened",1);
      }
      if(verified){
        if(n>=2&&n<=10){
          verifiedTarget++;
          readyChunk.push(entry.field);
          const existingEmails=[...(Array.isArray(lead.emails)?lead.emails:[]),lead.email].filter(isUsableLawEmail);
          const sourceVerifiedEmail=(lead.law_email_source_verified===true||lead.email_source_verified===true)&&existingEmails.length>0;
          if(!sourceVerifiedEmail){
            // A new size-ready email method gets a fresh bounded retry budget.
            // This only resets already-proven 2-10/no-site firms, not the 8k+
            // generic recovery backlog.
            if(String(lead.size_ready_email_method_version||"")!==SIZE_READY_EMAIL_METHOD_VERSION){
              lead={...lead,
                email_recovery_attempts:0,
                law_email_validation:"recovery_pending",
                size_ready_email_method_version:SIZE_READY_EMAIL_METHOD_VERSION
              };
              await redis.hSet(LEAD_HASH,entry.field,JSON.stringify(lead));
            }
            sizeReadyEmailChunk.push(entry.field);
          }
        }else{
          wrongSizeKnown++;
          if(n===1)verifiedSolo++; else if(n>10)verifiedOversize++;
        }
      }else{
        const exhaustedCurrentMethod=
          String(lead.phone_headcount_status||"")==="unverified" &&
          String(lead.phone_headcount_method_version||"")===PHONE_HEADCOUNT_METHOD_VERSION;
        if(!exhaustedCurrentMethod){
          const shape=lawFirmNameShape(lead);
          if(shape==="multi"||shape==="firm"){
            priorityChunk.push(entry.field);
            priorityByState.set(stateCode,(priorityByState.get(stateCode)||0)+1);
          }else pendingChunk.push(entry.field);
        }
      }

      if(pendingChunk.length+priorityChunk.length+readyChunk.length+sizeReadyEmailChunk.length>=750)await flush();
    }
  }
  await flush();
  console.log(JSON.stringify({
    event:"law_phone_first_fast_bootstrap",
    scanned,callableNoSite,queuedHeadcount,seededCallReady,wrongSizeKnown,
    verifiedSolo,verifiedTarget,verifiedOversize,
    topCallableStates:[...callableByState.entries()].sort((a,b)=>b[1]-a[1]).slice(0,15),
    topPriorityStates:[...priorityByState.entries()].sort((a,b)=>b[1]-a[1]).slice(0,15),
    headcountPriorityQueue:await redis.sCard(PHONE_HEADCOUNT_PRIORITY_SET),
    headcountQueue:await redis.sCard(CHICAGO_PENDING_SET),
    callReady:await redis.sCard(CALL_READY_SET)
  }));
  return {scanned,callableNoSite,queuedHeadcount,seededCallReady,wrongSizeKnown};
}

console.log(JSON.stringify({event:"law_firm_pipeline_boot",phase:"phone_first_fast_bootstrap"}));
await bootstrapPhoneFirstInventory();

// The old email-first bootstrap does useful cleanup and email evidence recovery,
// but it is too expensive to sit on the critical path. Run it in the background
// while the phone/headcount workers start immediately.
void (async()=>{
  console.log(JSON.stringify({event:"law_firm_pipeline_boot",phase:"background_legacy_bootstrap"}));
  await bootstrapExistingQualified();
  await normalizeEmailQueues();
  console.log(JSON.stringify({event:"law_firm_pipeline_boot",phase:"background_legacy_bootstrap_complete"}));
})().catch(error=>console.error("law_background_bootstrap_error",error?.stack||error?.message||error));

// Email is bonus for the calling campaign. Do not block the entire production
// pipeline on expensive candidate cleanup before headcount workers can start.
setTimeout(()=>{
  void cleanupEmailCandidateSet().catch(error=>console.error("law_email_candidate_cleanup_error",error?.message||error));
},5*60*1000).unref?.();
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

let LAST_ENRICH_CYCLE_AT=Date.now(),LAST_ENRICH_CYCLE_MS=0;
let LAST_SIZE_READY_CYCLE_AT=Date.now(),LAST_SIZE_READY_CYCLE_MS=0;
async function sizeReadyConversionLoop(){
  while(true){
    try{
      const cycleStarted=Date.now();
      const converted=await enrichSizeReadyBatch();
      LAST_SIZE_READY_CYCLE_MS=Date.now()-cycleStarted;
      LAST_SIZE_READY_CYCLE_AT=Date.now();
      if(converted||LAST_SIZE_READY_CYCLE_MS>15000){
        console.log(JSON.stringify({
          event:"law_size_ready_cycle",
          converted,
          cycleMs:LAST_SIZE_READY_CYCLE_MS,
          pendingSizeReady:await redis.sCard(SIZE_READY_PENDING_SET),
          uniqueEligible:await redis.sCard(UNIQUE_ELIGIBLE_SET)
        }));
      }
    }catch(error){console.error("law_size_ready_loop_error",error?.stack||error?.message||error);}
    await sleep(Math.max(1200,Math.min(LOOP_MS,3000)));
  }
}
async function enrichmentLoop(){
  while(true){
    try{
      const cycleStarted=Date.now();
      const enriched=await enrichBatch();
      LAST_ENRICH_CYCLE_MS=Date.now()-cycleStarted;
      LAST_ENRICH_CYCLE_AT=Date.now();
      const [queue,qualified,enrichedTotal,rejected,pending,pendingEmail,pendingRecoverable,pendingSource,pendingSizeReady,websitePending,websiteReady,currentEmailCandidates,uniqueVerifiedEmails,uniqueVerifiedHeadcounts,uniqueEligibleLeads,emailStats]=await Promise.all([
        redis.lLen(ACTIVE_QUEUE),redis.sCard(READY_SET),redis.sCard(ENRICHED_SET),redis.sCard(REJECTED_SET),
        redis.sCard(PENDING_SET),redis.sCard(PRIORITY_PENDING_SET),redis.sCard(RECOVERABLE_PENDING_SET),redis.sCard(SOURCE_PENDING_SET),redis.sCard(SIZE_READY_PENDING_SET),
        redis.sCard(WEBSITE_AUDIT_PENDING_SET),redis.sCard(WEBSITE_REFRESH_READY_SET),redis.sCard(EMAIL_CANDIDATE_SET),
        redis.sCard(UNIQUE_VERIFIED_EMAIL_SET),redis.sCard(UNIQUE_VERIFIED_HEADCOUNT_SET),redis.sCard(UNIQUE_ELIGIBLE_SET),
        redis.hmGet(STATS,["email_existing_hit","email_duck_hit","email_bing_hit","email_zero_cost_hit","email_no_hit","scrapling_source_hit","scrapling_source_fail","email_verifier_unavailable","scrapling_search_hit","bing_source_links","bing_source_pages_matched","bing_source_email_pages","email_raw_candidate_leads","email_identity_mx_pass_leads","email_identity_mx_reject_leads","email_keelead_pass_leads","email_keelead_reject_leads","email_source_verified_leads","jina_source_hit","jina_source_fail","email_existing_recorroborated","email_existing_recorroboration_miss","post_email_headcount_verified","post_email_headcount_miss","post_email_headcount_bing","post_email_headcount_duck","rejected_no_verified_email","rejected_unverified_attorney_count","rejected_wrong_size","rejected_has_website","scrapling_static_hit","scrapling_static_fail","bing_queries_with_links","bing_source_page_fetch_reject","bing_rss_query_hit","bing_query_fetch_reject","bing_fallback_error","email_source_binding_reject_leads","scrapling_generic_skip","owned_website_research_hit","website_preflight_hit","website_preflight_miss","bar_query_hit","bar_source_page_matched","bar_email_page","email_zero_cost_fail","email_source_binding_page_miss","email_source_binding_identity_reject","email_source_binding_exact_email_miss","email_source_binding_fetch_error","website_preflight_deferred","scrapling_browser_skip","bing_relative_result_links","scrapling_broad_discovery_skip","bing_source_raw_email_pages","bing_source_context_reject_email_pages","duck_source_raw_email_pages","duck_source_context_reject_email_pages","owned_website_verified_email_hit","bing_generic_link_reject","calbar_decoy_email_reject","bing_trusted_link_reject","expected_bar_query_with_links","expected_bar_result_links","expected_bar_page_matched","expected_bar_email_page","yahoo_expected_bar_query_hit","yahoo_expected_bar_result_links","yahoo_expected_bar_query_miss","yahoo_expected_bar_fetch_error","expected_bar_eligible_query_checks","expected_bar_query_executed","expected_bar_state_direct","expected_bar_state_derived","direct_calbar_search_attempt","direct_calbar_profile_links","direct_calbar_search_error","direct_calbar_page_matched","direct_calbar_email_page","candidate_owned_website_recheck_hit","calbar_profile_identity_reject","calbar_profile_website_hit","candidate_calbar_identity_reject","candidate_calbar_website_hit","owner_name_firm_label_bypass","direct_calbar_unique_profile","direct_calbar_deep_read_attempt","direct_calbar_deep_read_match","enrich_non_destructive_batch_selected","direct_calbar_deep_read_chars","direct_calbar_active_from_search","direct_calbar_unique_active","calbar_strong_email_accept","direct_calbar_search_identity_reject","direct_lawyercom_size_attempt","direct_lawyercom_size_hit","direct_lawyercom_size_miss","post_email_headcount_direct_lawyercom","candidate_source_owned_website_hit","candidate_lawyercom_size_hit","candidate_lawyercom_website_hit","candidate_source_email_phone_owned_hit","candidate_source_jina_recheck","direct_txbar_search_attempt","direct_txbar_profile_links","direct_txbar_search_error","direct_ilbar_search_attempt","direct_ilbar_profile_links","direct_ilbar_search_error","direct_gabar_search_attempt","direct_gabar_profile_links","direct_gabar_search_error","direct_ncbar_search_attempt","direct_ncbar_profile_links","direct_ncbar_search_error","direct_wabar_search_attempt","direct_wabar_profile_links","direct_wabar_search_error","direct_floridabar_search_attempt","direct_floridabar_profile_links","direct_floridabar_search_error"])
      ]);
      console.log(JSON.stringify({
        event:"law_firm_pipeline_cycle",seeded:null,enriched,enrichCycleMs:LAST_ENRICH_CYCLE_MS,queue,qualified,enrichedTotal,rejected,pending,pendingEmail,pendingRecoverable,pendingSource,pendingSizeReady,websitePending,websiteReady,
        emailExisting:Number(emailStats?.[0]||0),emailDuck:Number(emailStats?.[1]||0),emailBing:Number(emailStats?.[2]||0),
        emailZeroCost:Number(emailStats?.[3]||0),emailNoHit:Number(emailStats?.[4]||0),
        scraplingSourceHit:Number(emailStats?.[5]||0),scraplingSourceFail:Number(emailStats?.[6]||0),
        emailVerifierUnavailable:Number(emailStats?.[7]||0),scraplingSearchHit:Number(emailStats?.[8]||0),
        bingSourceLinks:Number(emailStats?.[9]||0),bingSourcePagesMatched:Number(emailStats?.[10]||0),
        bingSourceEmailPages:Number(emailStats?.[11]||0),
        emailRawCandidateAttempts:Number(emailStats?.[12]||0),emailIdentityMxPassAttempts:Number(emailStats?.[13]||0),
        emailIdentityMxRejectAttempts:Number(emailStats?.[14]||0),emailKeeleadInfrastructurePassAttempts:Number(emailStats?.[15]||0),
        emailKeeleadInfrastructureRejectAttempts:Number(emailStats?.[16]||0),emailSourceVerifiedAttempts:Number(emailStats?.[17]||0),currentEmailCandidates,uniqueVerifiedEmails,uniqueVerifiedHeadcounts,uniqueEligibleLeads,jinaSourceHit:Number(emailStats?.[18]||0),jinaSourceFail:Number(emailStats?.[19]||0),emailExistingRecorroborated:Number(emailStats?.[20]||0),emailExistingRecorroborationMiss:Number(emailStats?.[21]||0),postEmailHeadcountVerified:Number(emailStats?.[22]||0),postEmailHeadcountMiss:Number(emailStats?.[23]||0),
        postEmailHeadcountBing:Number(emailStats?.[24]||0),postEmailHeadcountDuck:Number(emailStats?.[25]||0),
        rejectedNoVerifiedEmail:Number(emailStats?.[26]||0),rejectedUnverifiedAttorneyCount:Number(emailStats?.[27]||0),
        rejectedWrongSize:Number(emailStats?.[28]||0),rejectedHasWebsite:Number(emailStats?.[29]||0),
        scraplingStaticHit:Number(emailStats?.[30]||0),scraplingStaticFail:Number(emailStats?.[31]||0),bingQueriesWithLinks:Number(emailStats?.[32]||0),bingSourcePageFetchReject:Number(emailStats?.[33]||0),bingRssQueryHit:Number(emailStats?.[34]||0),bingQueryFetchReject:Number(emailStats?.[35]||0),bingFallbackError:Number(emailStats?.[36]||0),emailSourceBindingRejectLeads:Number(emailStats?.[37]||0),scraplingGenericSkip:Number(emailStats?.[38]||0),ownedWebsiteResearchHit:Number(emailStats?.[39]||0),websitePreflightHit:Number(emailStats?.[40]||0),websitePreflightMiss:Number(emailStats?.[41]||0),barQueryHit:Number(emailStats?.[42]||0),barSourcePageMatched:Number(emailStats?.[43]||0),barEmailPage:Number(emailStats?.[44]||0),emailZeroCostFail:Number(emailStats?.[45]||0),emailSourceBindingPageMiss:Number(emailStats?.[46]||0),emailSourceBindingIdentityReject:Number(emailStats?.[47]||0),emailSourceBindingExactEmailMiss:Number(emailStats?.[48]||0),emailSourceBindingFetchError:Number(emailStats?.[49]||0),websitePreflightDeferred:Number(emailStats?.[50]||0),scraplingBrowserSkip:Number(emailStats?.[51]||0),bingRelativeResultLinks:Number(emailStats?.[52]||0),scraplingBroadDiscoverySkip:Number(emailStats?.[53]||0),bingSourceRawEmailPages:Number(emailStats?.[54]||0),bingSourceContextRejectEmailPages:Number(emailStats?.[55]||0),duckSourceRawEmailPages:Number(emailStats?.[56]||0),duckSourceContextRejectEmailPages:Number(emailStats?.[57]||0),ownedWebsiteVerifiedEmailHit:Number(emailStats?.[58]||0),bingGenericLinkReject:Number(emailStats?.[59]||0),calbarDecoyEmailReject:Number(emailStats?.[60]||0),bingTrustedLinkReject:Number(emailStats?.[61]||0),expectedBarQueryWithLinks:Number(emailStats?.[62]||0),expectedBarResultLinks:Number(emailStats?.[63]||0),expectedBarPageMatched:Number(emailStats?.[64]||0),expectedBarEmailPage:Number(emailStats?.[65]||0),yahooExpectedBarQueryHit:Number(emailStats?.[66]||0),yahooExpectedBarResultLinks:Number(emailStats?.[67]||0),yahooExpectedBarQueryMiss:Number(emailStats?.[68]||0),yahooExpectedBarFetchError:Number(emailStats?.[69]||0),expectedBarEligibleQueryChecks:Number(emailStats?.[70]||0),expectedBarQueryExecuted:Number(emailStats?.[71]||0),expectedBarStateDirect:Number(emailStats?.[72]||0),expectedBarStateDerived:Number(emailStats?.[73]||0),directCalbarSearchAttempt:Number(emailStats?.[74]||0),directCalbarProfileLinks:Number(emailStats?.[75]||0),directCalbarSearchError:Number(emailStats?.[76]||0),directCalbarPageMatched:Number(emailStats?.[77]||0),directCalbarEmailPage:Number(emailStats?.[78]||0),candidateOwnedWebsiteRecheckHit:Number(emailStats?.[79]||0),calbarProfileIdentityReject:Number(emailStats?.[80]||0),calbarProfileWebsiteHit:Number(emailStats?.[81]||0),candidateCalbarIdentityReject:Number(emailStats?.[82]||0),candidateCalbarWebsiteHit:Number(emailStats?.[83]||0),ownerNameFirmLabelBypass:Number(emailStats?.[84]||0),directCalbarUniqueProfile:Number(emailStats?.[85]||0),directCalbarDeepReadAttempt:Number(emailStats?.[86]||0),directCalbarDeepReadMatch:Number(emailStats?.[87]||0),enrichNonDestructiveBatchSelected:Number(emailStats?.[88]||0),directCalbarDeepReadChars:Number(emailStats?.[89]||0),directCalbarActiveFromSearch:Number(emailStats?.[90]||0),directCalbarUniqueActive:Number(emailStats?.[91]||0),calbarStrongEmailAccept:Number(emailStats?.[92]||0),directCalbarSearchIdentityReject:Number(emailStats?.[93]||0),directLawyercomSizeAttempt:Number(emailStats?.[94]||0),directLawyercomSizeHit:Number(emailStats?.[95]||0),directLawyercomSizeMiss:Number(emailStats?.[96]||0),postEmailHeadcountDirectLawyercom:Number(emailStats?.[97]||0),candidateSourceOwnedWebsiteHit:Number(emailStats?.[98]||0),candidateLawyercomSizeHit:Number(emailStats?.[99]||0),candidateLawyercomWebsiteHit:Number(emailStats?.[100]||0),candidateSourceEmailPhoneOwnedHit:Number(emailStats?.[101]||0),candidateSourceJinaRecheck:Number(emailStats?.[102]||0),directTxbarSearchAttempt:Number(emailStats?.[103]||0),directTxbarProfileLinks:Number(emailStats?.[104]||0),directTxbarSearchError:Number(emailStats?.[105]||0),directIlbarSearchAttempt:Number(emailStats?.[106]||0),directIlbarProfileLinks:Number(emailStats?.[107]||0),directIlbarSearchError:Number(emailStats?.[108]||0),directGabarSearchAttempt:Number(emailStats?.[109]||0),directGabarProfileLinks:Number(emailStats?.[110]||0),directGabarSearchError:Number(emailStats?.[111]||0),directNcbarSearchAttempt:Number(emailStats?.[112]||0),directNcbarProfileLinks:Number(emailStats?.[113]||0),directNcbarSearchError:Number(emailStats?.[114]||0),directWabarSearchAttempt:Number(emailStats?.[115]||0),directWabarProfileLinks:Number(emailStats?.[116]||0),directWabarSearchError:Number(emailStats?.[117]||0),directFloridabarSearchAttempt:Number(emailStats?.[118]||0),directFloridabarProfileLinks:Number(emailStats?.[119]||0),directFloridabarSearchError:Number(emailStats?.[120]||0)
      }));
    }catch(error){console.error("law_firm_enrich_loop_error",error?.stack||error?.message||error);}
    await sleep(LOOP_MS);
  }
}

async function statusLoop(){
  while(true){
    try{
      const [qualified,uniqueEligible,callReady,verifiedEmails,verifiedHeadcounts,emailCandidates,pendingRegular,pendingPriority,pendingRecoverable,pendingSizeReady,phoneHeadcountPriority,phoneHeadcountPending]=await Promise.all([
        redis.sCard(READY_SET),redis.sCard(UNIQUE_ELIGIBLE_SET),redis.sCard(CALL_READY_SET),
        redis.sCard(UNIQUE_VERIFIED_EMAIL_SET),redis.sCard(UNIQUE_VERIFIED_HEADCOUNT_SET),
        redis.sCard(EMAIL_CANDIDATE_SET),redis.sCard(PENDING_SET),
        redis.sCard(PRIORITY_PENDING_SET),redis.sCard(RECOVERABLE_PENDING_SET),
        redis.sCard(SIZE_READY_PENDING_SET),redis.sCard(PHONE_HEADCOUNT_PRIORITY_SET),redis.sCard(CHICAGO_PENDING_SET)
      ]);
      const enrichSilenceMs=Math.max(0,Date.now()-LAST_ENRICH_CYCLE_AT);
      const sizeReadySilenceMs=Math.max(0,Date.now()-LAST_SIZE_READY_CYCLE_AT);
      console.log(JSON.stringify({
        event:"law_firm_pipeline_heartbeat",qualified,uniqueEligible,callReady,verifiedEmails,verifiedHeadcounts,emailCandidates,
        phoneHeadcountPriority,phoneHeadcountPending,pendingRegular,pendingPriority,pendingRecoverable,pendingSizeReady,
        lastEnrichCycleMs:LAST_ENRICH_CYCLE_MS,enrichSilenceMs,
        lastSizeReadyCycleMs:LAST_SIZE_READY_CYCLE_MS,sizeReadySilenceMs,
        enrichmentStalled:enrichSilenceMs>Math.max(180000,LOOP_MS*6),
        sizeReadyStalled:pendingSizeReady>0&&sizeReadySilenceMs>Math.max(120000,LOOP_MS*4)
      }));
    }catch(error){
      console.error("law_firm_status_loop_error",error?.stack||error?.message||error);
    }
    await sleep(30000);
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

await Promise.all([seedLoop(),directorySeedLoop(),sizeReadyConversionLoop(),enrichmentLoop(),statusLoop()]);
