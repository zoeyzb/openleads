import { createClient } from "redis";
import { randomUUID } from "node:crypto";
import { matchesRequestedLocation, upsertQualifiedLeads } from "./acquisition-persistence.mjs";
import { markCoverage, campaignLeadSetKey } from "./acquisition-coverage.mjs";
import { isCoreHomeServiceLead, isCoreHomeServiceIndustry, isOwnedBusinessWebsite } from "./home-service-targeting.mjs";

const REDIS_URL = process.env.ACQUISITION_REDIS_URL || process.env.REDIS_URL || "";
const MAPS_BASE_URL = (process.env.MAPS_BASE_URL || "").replace(/\/$/, "");
const MAPS_BASE_URLS = String(process.env.MAPS_BASE_URLS || MAPS_BASE_URL)
  .split(",").map(x=>x.trim().replace(/\/$/,"")).filter(Boolean);
const DATAFORGE_BASE_URL = (process.env.DATAFORGE_BASE_URL || "").replace(/\/$/, "");
const DATAFORGE_API_TOKEN = process.env.DATAFORGE_API_TOKEN || "";
const JOB_TTL = Number(process.env.ACQUISITION_TTL_SECONDS || 604800);
const RAW_TTL_SECONDS = Math.max(300, Number(process.env.ACQUISITION_RAW_TTL_SECONDS || 7200));
const RESULT_TTL_SECONDS = Math.max(3600, Number(process.env.ACQUISITION_RESULT_TTL_SECONDS || 86400));
const POLL_MS = Number(process.env.ACQUISITION_POLL_MS || 10000);
const LEASE_SECONDS = Number(process.env.ACQUISITION_LEASE_SECONDS || 180);
const RETRY_ATTEMPTS = Number(process.env.ACQUISITION_RETRY_ATTEMPTS || 3);
const MAPS_ROUND_DEPTH_CAP = Number(process.env.MAPS_ROUND_DEPTH_CAP || 25);
const MAPS_ROUND_MAX_TIME_SECONDS = Number(process.env.MAPS_ROUND_MAX_TIME_SECONDS || 300);
let shuttingDown = false;
let currentJobId = null;

if (!REDIS_URL) throw new Error("ACQUISITION_REDIS_URL is required");
if (!MAPS_BASE_URLS.length) throw new Error("MAPS_BASE_URL or MAPS_BASE_URLS is required");

function mapsBaseFor(acquisitionId) {
  let hash=0;
  for (const ch of String(acquisitionId||"")) hash=(hash*31+ch.charCodeAt(0))>>>0;
  return MAPS_BASE_URLS[hash % MAPS_BASE_URLS.length];
}

function mapsLaneCooldownKey(url) {
  return "recover:maps:lane:cooldown:"+Buffer.from(String(url||"")).toString("base64url");
}
async function markMapsLaneUnavailable(url, seconds=75) {
  if (!url) return;
  try { await redis.set(mapsLaneCooldownKey(url),"1",{EX:seconds}); } catch {}
}
async function nextMapsBase(acquisitionId) {
  if (MAPS_BASE_URLS.length <= 1) return MAPS_BASE_URLS[0];
  try {
    let fallback=MAPS_BASE_URLS[0];
    for (let attempt=0; attempt<MAPS_BASE_URLS.length; attempt++) {
      const n=await redis.incr("recover:maps:round_robin");
      const candidate=MAPS_BASE_URLS[(n-1) % MAPS_BASE_URLS.length];
      fallback=candidate;
      const cooling=await redis.exists(mapsLaneCooldownKey(candidate));
      if (!cooling) return candidate;
    }
    return fallback;
  } catch {
    return mapsBaseFor(acquisitionId);
  }
}

async function createMapsJobWithFailover(acquisitionId, payload) {
  const maxAttempts=Math.max(1,Math.min(MAPS_BASE_URLS.length,RETRY_ATTEMPTS+1));
  const tried=new Set();
  let lastError;

  for (let attempt=1; attempt<=maxAttempts; attempt++) {
    let mapsBase=await nextMapsBase(acquisitionId);
    if (tried.has(mapsBase) && tried.size<MAPS_BASE_URLS.length) {
      for (let i=0;i<MAPS_BASE_URLS.length;i++) {
        const candidate=await nextMapsBase(acquisitionId);
        if (!tried.has(candidate)) { mapsBase=candidate; break; }
      }
    }
    tried.add(mapsBase);

    try {
      const create=await fetchJson(`${mapsBase}/api/v1/jobs`,{
        method:"POST",
        headers:{"content-type":"application/json"},
        body:JSON.stringify(payload)
      },30000);
      return {mapsBase,create};
    } catch (error) {
      lastError=error;
      if (isRetryableError(error)) await markMapsLaneUnavailable(mapsBase);
      if (!isRetryableError(error) || attempt>=maxAttempts) throw error;
      const delay=500+Math.floor(Math.random()*500);
      console.warn("Maps create failover", "attempt", attempt, "failed via", mapsBase, "switching lane in", delay, "ms:", error.message);
      await sleep(delay);
    }
  }
  throw lastError;
}

const redis = createClient({ url: REDIS_URL });
redis.on("error", err => console.error("Redis error", err));

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isRetryableError(error) {
  const message = String(error?.message || error || "");
  if (/\b(408|425|429|500|502|503|504)\b/.test(message)) return true;
  return /abort|timeout|timed out|fetch failed|econnreset|econnrefused|socket|network/i.test(message);
}

async function withRetry(label, fn, attempts = RETRY_ATTEMPTS) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (shuttingDown) throw new Error("worker shutting down");
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableError(error)) throw error;
      const delay = Math.min(15000, 1000 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 500);
      console.warn(label, "attempt", attempt, "failed; retrying in", delay, "ms:", error.message);
      await sleep(delay);
    }
  }
  throw lastError;
}

async function fetchJson(url, init = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw:text }; }
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(body).slice(0,500)}`);
    return body;
  } finally { clearTimeout(timer); }
}

async function fetchText(url, init = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0,500)}`);
    return text;
  } finally { clearTimeout(timer); }
}

function parseCsv(text) {
  const rows=[]; let row=[], field="", quoted=false;
  for (let i=0;i<text.length;i++) {
    const ch=text[i];
    if (quoted) {
      if (ch === '"' && text[i+1] === '"') { field+='"'; i++; }
      else if (ch === '"') quoted=false;
      else field+=ch;
    } else {
      if (ch === '"') quoted=true;
      else if (ch === ',') { row.push(field); field=""; }
      else if (ch === '\n') { row.push(field); rows.push(row); row=[]; field=""; }
      else if (ch !== '\r') field+=ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers=rows.shift().map(h=>h.trim());
  return rows.filter(r=>r.some(v=>String(v).trim())).map(r=>{
    const obj={}; headers.forEach((h,i)=>obj[h]=r[i]??""); return obj;
  });
}

function normalizeDomain(value="") {
  try {
    const url=value.includes("://")?new URL(value):new URL("https://"+value);
    return url.hostname.toLowerCase().replace(/^www\./,"");
  } catch { return String(value).toLowerCase().replace(/^www\./,"").replace(/\/$/,""); }
}
function normalizePhone(value="") { return String(value).replace(/\D/g,"").slice(-10); }
function normalizeText(value="") { return String(value).toLowerCase().replace(/[^a-z0-9]+/g," ").trim(); }
function normalizeEmails(value) {
  const values=Array.isArray(value)?value:String(value||"").split(/[;,\s]+/);
  return [...new Set(values.map(x=>String(x).trim().toLowerCase()).filter(x=>/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))];
}
function ownerNameFromLead(lead) {
  if (lead.owner_name) return String(lead.owner_name);
  if (!lead.owner) return "";
  if (typeof lead.owner === "object") return String(lead.owner.name||"");
  try { return String(JSON.parse(String(lead.owner))?.name||""); } catch { return ""; }
}
function dedupeRecords(records) {
  const seen=new Set(), out=[];
  for (const lead of records) {
    const place=String(lead.place_id||"").trim();
    const cid=String(lead.cid||"").trim();
    const dataId=String(lead.data_id||lead.dataid||"").trim();
    const nameAddr=normalizeText((lead.name||lead.title||"")+"|"+(lead.address||""));
    const phone=normalizePhone(lead.phone||"");
    // Prefer Maps-stable business identifiers. A shared phone number can belong
    // to multiple branches, so do not collapse distinct CIDs/place IDs by phone.
    const key=place ? "place:"+place
      : cid ? "cid:"+cid
      : dataId ? "data:"+dataId
      : nameAddr && String(lead.address||"").trim() ? "na:"+nameAddr
      : phone ? "phone:"+phone
      : "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(lead);
  }
  return out;
}
function isHomeComfortTarget(industry="") {
  return isCoreHomeServiceIndustry(industry);
}
function matchesHomeComfortTrade(lead) {
  return isCoreHomeServiceLead(lead);
}
function matchesFastNyState(lead) {
  const address=String(lead.address||lead.full_address||lead.formatted_address||"").toLowerCase();
  const region=String(lead.region||lead.state||lead.state_code||lead.province||"").toLowerCase().trim();
  const city=String(lead.city||lead.locality||lead.town||"").toLowerCase().trim();
  const explicitOther=/,\s*(al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy)\b/i.test(address);
  if (explicitOther) return false;
  if (/^(ny|new york)$/.test(region)) return true;
  if (/,\s*ny\b|new york\b/i.test(address)) return true;
  return /new york/.test(city) && !region;
}
function isFastNyMilestoneJob(job) {
  return String(job?.batch_id||"")==="ny-home-comfort-fast-1000-2026-09-09" ||
    (String(job?.industry||"")==="HOME_COMFORT_TRADES" && /\bny\b|new york/i.test(String(job?.location||"")));
}
function matchesAcquisitionLocation(lead, job) {
  return isFastNyMilestoneJob(job) ? matchesFastNyState(lead) : matchesRequestedLocation(lead,job.location);
}
function isFastHomeServiceJob(job) {
  return isFastNyMilestoneJob(job) || String(job?.search_profile||"")==="core-home-service";
}

function matchesRequestedIndustry(lead, industry) {
  const target=normalizeText(industry||"");
  const hay=normalizeText((lead.category||"")+" "+(lead.title||lead.name||"")+" "+(lead.descriptions||""));
  if (!target) return true;
  if (isHomeComfortTarget(target)) return matchesHomeComfortTrade(lead);
  if (/roof/.test(target)) return /roof/.test(hay);
  if (/electric/.test(target)) return /electric/.test(hay);
  if (/landscap/.test(target)) return /landscap|lawn|tree service/.test(hay);
  if (/dent/.test(target)) return /dent/.test(hay);
  if (/restaurant|food/.test(target)) return /restaurant|food|cafe|grill|kitchen/.test(hay);
  const tokens=target.split(" ").filter(x=>x.length>=4);
  return tokens.length===0 || tokens.some(t=>hay.includes(t));
}
function sameRequestedState(lead,job={}){
  const requested=normalizeText(job.partition_state||"");
  if(!requested) return false;
  const region=normalizeText(lead.region||lead.state||lead.state_code||lead.province||"");
  const address=normalizeText(lead.address||lead.full_address||lead.formatted_address||"");
  if(region) return region===requested || region.split(" ").includes(requested);
  return new RegExp("\\b"+requested.replace(/[^a-z]/g,"")+"\\b").test(address);
}
function locationCandidateSet(records=[],job={}){
  if(String(job.search_profile||"")!=="core-home-service") return records.filter(lead=>matchesAcquisitionLocation(lead,job));
  const strict=records.filter(lead=>matchesAcquisitionLocation(lead,job));
  const passNum=Number(String(job.coverage_pass||"").match(/p(\d+)$/)?.[1]||1);
  const fallbackCap=passNum>=4?24:12;
  if(strict.length>=fallbackCap) return strict;
  // Maps ZIP searches routinely surface nearby suburbs/service-area businesses.
  // Keep strict matches first, then admit a bounded same-state tail from the
  // same Maps result set. Later passes widen this tail because those passes are
  // explicitly for discovering businesses missed by the exact ZIP/city slice.
  const strictKeys=new Set(strict.map(permanentLeadIdentity));
  const nearby=records
    .filter(lead=>!strictKeys.has(permanentLeadIdentity(lead))&&sameRequestedState(lead,job))
    .slice(0,Math.max(0,fallbackCap-strict.length));
  if(nearby.length) console.log(JSON.stringify({event:"location_relaxation",acquisition_id:job.id,strict:strict.length,nearby:nearby.length,cap:fallbackCap,coverage_pass:job.coverage_pass,location:job.location}));
  return [...strict,...nearby];
}

function qualificationFunnel(records=[],job={}){
  const candidates=locationCandidateSet(records,job);
  const counts={raw:records.length,location:Math.max(0,records.length-candidates.length),industry:0,owned_website:0,phone:0,email:0,contact:0,include_website:0,score:0,accepted:0};
  for(const lead of candidates){
    if(!matchesRequestedIndustry(lead,job.industry)){counts.industry++;continue;}
    if(job.require_no_website&&isOwnedBusinessWebsite(lead.website)){counts.owned_website++;continue;}
    if(job.require_phone&&!lead.phone){counts.phone++;continue;}
    if(job.require_email&&!normalizeEmails(lead.emails||lead.email||"").length){counts.email++;continue;}
    if(job.require_contact&&!lead.phone&&!normalizeEmails(lead.emails||lead.email||"").length){counts.contact++;continue;}
    if(job.include_no_website===false&&!lead.website){counts.include_website++;continue;}
    if(scoreLead(lead).score<Number(job.min_score||0)){counts.score++;continue;}
    counts.accepted++;
  }
  return counts;
}

function scoreLead(lead) {
  let score=0; const reasons=[]; const add=(p,r)=>{score+=p;reasons.push({points:p,reason:r});};
  const category=normalizeText(lead.category||lead.industry||"");
  if (/hvac|heating|air conditioning|plumb|roof|electric/.test(category)) add(15,"target local-service category");
  if (!isOwnedBusinessWebsite(lead.website)) add(20,"no owned website");
  if (lead.website && lead.website_status && lead.website_status!=="ok") add(10,"website fetch/health problem");
  if (lead.website && lead.ssl_valid===false) add(10,"website SSL problem");
  if (lead.website && Number(lead.site_speed_ms||0)>=3000) add(10,"slow website");
  const reviews=Number(lead.review_count||lead.reviews||0);
  if (reviews>=20) add(10,"20+ reviews");
  if (Number(lead.review_rating||lead.rating||0)>=4.2) add(5,"strong rating");
  if (lead.phone) add(10,"phone available");
  if (normalizeEmails(lead.emails||lead.email||"").length) add(10,"email available");
  if (ownerNameFromLead(lead)) add(10,"owner signal available");
  score=Math.min(100,score);
  const tier=score>=85?"hot":score>=70?"strong":score>=50?"maybe":score>=30?"weak":"reject";
  return {score,tier,reasons};
}
function compactLead(lead) {
  return {
    name:lead.name||lead.title||"",
    category:lead.category||lead.industry||"",
    address:lead.address||"",
    city:lead.city||lead.locality||"",
    region:lead.region||lead.state||lead.state_code||"",
    website:isOwnedBusinessWebsite(lead.website)?(lead.website||""):"",
    social_profile_url:(!isOwnedBusinessWebsite(lead.website)&&lead.website)?String(lead.website):"",
    phone:lead.phone||"",
    emails:normalizeEmails(lead.emails||lead.email||""),
    owner_name:ownerNameFromLead(lead),
    google_maps_url:lead.link||lead.google_maps_url||"",
    place_id:lead.place_id||"",
    cid:lead.cid||"",
    data_id:lead.data_id||lead.dataid||"",
    review_count:Number(lead.review_count||lead.reviews||0),
    review_rating:Number(lead.review_rating||lead.rating||0),
    latitude:lead.latitude?Number(lead.latitude):null,
    longitude:lead.longitude?Number(lead.longitude):null,
    tech_stack:Array.isArray(lead.tech_stack)?lead.tech_stack:[],
    cms_detected:lead.cms_detected||null,
    ssl_valid:typeof lead.ssl_valid==="boolean"?lead.ssl_valid:null,
    site_speed_ms:Number.isFinite(Number(lead.site_speed_ms))?Number(lead.site_speed_ms):null,
    website_status:lead.website_status||null,
    qualification:lead.qualification||null
  };
}

function permanentLeadIdentity(lead) {
  if (lead.place_id) return "place:"+String(lead.place_id).trim();
  if (lead.cid) return "cid:"+String(lead.cid).trim();
  if (lead.data_id) return "data:"+String(lead.data_id).trim();
  const domain=normalizeDomain(lead.website||"");
  if (domain) return "domain:"+domain;
  const nameAddr=normalizeText((lead.name||lead.title||"")+"|"+(lead.address||""));
  if (nameAddr && String(lead.address||"").trim()) return "nameaddr:"+nameAddr;
  const phone=normalizePhone(lead.phone||"");
  if (phone) return "phone:"+phone;
  return "nameaddr:"+nameAddr;
}
function areaYieldField(job={}) {
  const pass=Number(String(job.coverage_pass||"").match(/p(\d+)$/)?.[1]||1);
  const denseLaterPass=pass>=3&&Number(job.source_population||0)>=10000;
  const cityScopedPass=pass>=5;
  return [
    normalizeText(job.partition_state||""),
    normalizeText(job.partition_city||""),
    (cityScopedPass||pass>=3&&!denseLaterPass) ? "*" : normalizeText(job.partition_zip||job.source_zip||""),
    cityScopedPass ? normalizeText(job.query_family||"") : ""
  ].join("|");
}
async function recordAreaYield(redis,job) {
  if (job.area_yield_recorded) return;
  const field=areaYieldField(job);
  if (!field || field==="||") return;
  const netNew=Math.max(0,Number(job.permanent_new_count||0));
  const duplicates=Math.max(0,Number(job.permanent_duplicate_count||0));
  await Promise.all([
    redis.hIncrBy("recover:yield:area:attempts",field,1),
    redis.hIncrBy("recover:yield:area:new",field,netNew),
    redis.hIncrBy("recover:yield:area:duplicates",field,duplicates),
  ]);
  job.area_yield_recorded=true;
  console.log("Acquisition area yield",job.id,"area",field,"global_new",netNew,"global_dup",duplicates);
}
async function persistPermanentQualified(redis, job, leads) {
  if (!Array.isArray(leads) || !leads.length) return {unique:0,newAdded:0,duplicates:0};

  const rows=leads.map(lead=>{
    const compact=compactLead(lead);
    const preferred=permanentLeadIdentity(compact);
    const phone=normalizePhone(compact.phone||"");
    const phoneKey=phone ? "phone:"+phone : "";
    const placeId=String(compact.place_id||"").trim();
    const sheetKey=placeId ? "place:"+placeId : phoneKey;
    return {compact,preferred,phoneKey,sheetKey};
  });

  const lookupKeys=[...new Set(rows.flatMap(row=>[row.preferred,row.phoneKey]).filter(Boolean))];
  const sheetLookupKeys=[...new Set(rows.map(row=>row.sheetKey).filter(Boolean))];
  const existingByKey=new Map();
  for(let i=0;i<lookupKeys.length;i+=500){
    const keys=lookupKeys.slice(i,i+500);
    const values=await redis.hmGet("recover:leadstore:qualified",keys);
    keys.forEach((key,j)=>existingByKey.set(key,values?.[j]||null));
  }
  const assignedSheetKeys=new Set();
  for(let i=0;i<sheetLookupKeys.length;i+=500){
    const keys=sheetLookupKeys.slice(i,i+500);
    const values=await redis.hmGet("recover:sheet:assigned:v1",keys);
    keys.forEach((key,j)=>{ if(values?.[j]) assignedSheetKeys.add(key); });
  }

  const entries=[];
  const identities=[];
  const seen=new Set();
  let existingCount=0;
  let historicalSheetDuplicates=0;
  let newAdded=0;

  for(const row of rows){
    const {compact,preferred,phoneKey,sheetKey}=row;
    let key=preferred;
    const existedInLeadstore=Boolean(existingByKey.get(preferred));
    const existedInSheet=Boolean(sheetKey && assignedSheetKeys.has(sheetKey));
    let existed=existedInLeadstore || existedInSheet;
    if(existedInSheet && !existedInLeadstore) historicalSheetDuplicates++;

    // Before the CID/data-id upgrade, no-website leads were commonly keyed by
    // phone. Reuse that legacy key only when it is clearly the same business.
    // A shared phone with a different address is allowed to remain a distinct
    // branch under its Maps-stable identifier.
    if(!existed && phoneKey && phoneKey!==preferred){
      const legacyRaw=existingByKey.get(phoneKey);
      if(legacyRaw){
        try{
          const legacy=JSON.parse(legacyRaw);
          const currentAddr=normalizeText(compact.address||"");
          const legacyAddr=normalizeText(legacy.address||"");
          const currentName=normalizeText(compact.name||"");
          const legacyName=normalizeText(legacy.name||"");
          const sameAddress=Boolean(currentAddr&&legacyAddr&&currentAddr===legacyAddr);
          const sameName=Boolean(currentName&&legacyName&&currentName===legacyName);
          if(sameAddress||sameName){
            key=phoneKey;
            existed=true;
          }
        }catch{}
      }
    }

    if(seen.has(key)) continue;
    seen.add(key);
    identities.push(key);
    if(existed) existingCount++; else newAdded++;

    entries.push(key,JSON.stringify({
      ...compact,
      acquisition_id:job.id,
      acquisition_location:job.location||"",
      industry:job.industry||"",
      campaign_scope:campaignLeadSetKey(job),
      persisted_at:new Date().toISOString()
    }));
  }

  if(entries.length) await redis.hSet("recover:leadstore:qualified",entries);
  if(identities.length){
    await redis.sAdd(campaignLeadSetKey(job),identities);
    if(/\\bny\\b|new york/i.test(String(job.location||"")) && isHomeComfortTarget(job.industry||"")){
      await redis.sAdd("recover:leadstore:ny-home-comfort",identities);
    }
  }
  if(historicalSheetDuplicates>0){
    console.log(JSON.stringify({
      event:"historical_sheet_dedupe",
      acquisition_id:job.id,
      historical_duplicates:historicalSheetDuplicates,
      candidates:identities.length
    }));
  }
  return {unique:identities.length,newAdded,duplicates:existingCount,historicalSheetDuplicates};
}
function mapsStatus(job) {
  return String(job?.status||job?.Status||job?.state||job?.State||job?.job?.status||job?.job?.Status||"").toLowerCase();
}
function mapsTerminal(job) { return ["ok","completed","complete","done","finished","success","succeeded"].some(x=>mapsStatus(job).includes(x)); }
function mapsFailed(job) { return ["failed","error","cancelled","canceled"].some(x=>mapsStatus(job).includes(x)); }

const HOME_COMFORT_QUERIES=[
  "heating and cooling contractor",
  "air conditioning repair service",
  "HVAC contractor",
  "heating contractor",
  "AC repair service",
  "furnace repair service",
  "boiler repair service",
  "air duct contractor",
  "ventilation contractor",
  "plumbing contractor",
  "plumber",
  "refrigeration contractor",
  "residential heating and cooling",
  "commercial heating and cooling",
  "emergency plumbing and HVAC",
  "heating cooling plumbing contractor",
  "furnace boiler contractor",
  "air conditioning installation",
  "heating repair service",
  "duct cleaning service",
  "heat pump contractor",
  "heat pump repair service",
  "water heater repair service",
  "water heater installation",
  "drain cleaning service",
  "sewer repair service",
  "pipe repair service",
  "geothermal heating contractor",
  "indoor air quality service",
  "thermostat installation service",
  "HVAC repair service",
  "air conditioning contractor",
  "air conditioning service",
  "residential HVAC contractor",
  "commercial HVAC contractor",
  "heating and air conditioning service",
  "furnace contractor",
  "boiler contractor",
  "heating installation service",
  "AC installation service",
  "ductless HVAC contractor",
  "mini split installation service",
  "emergency plumber",
  "plumbing repair service",
  "24 hour plumber",
  "water heater contractor",
  "drain service",
  "sewer service",
  "refrigeration service",
  "local HVAC company",
  "HVAC service company",
  "HVAC repair contractor",
  "heating repair contractor",
  "heating service company",
  "air conditioner repair",
  "air conditioner service",
  "AC service company",
  "furnace service",
  "boiler service",
  "ductwork contractor",
  "ductwork installation",
  "mini split contractor",
  "local plumber",
  "plumbing company",
  "plumbing service company",
  "emergency plumbing service",
  "water heater service",
  "drain contractor",
  "sewer contractor"
];
const queryVariants=(industry,location)=>{
  if (isHomeComfortTarget(industry)) return HOME_COMFORT_QUERIES.map(q=>`${q} in ${location}`);
  return [
    `${industry} in ${location}`,
    `${industry} contractor in ${location}`,
    `${industry} service company in ${location}`,
    `${industry} repair in ${location}`,
    `${industry} installation in ${location}`
  ];
};
function queryFamily(query=""){
  const value=String(query||"");
  const marker=value.lastIndexOf(" in ");
  return normalizeText(marker>0?value.slice(0,marker):value);
}

function geoBiasForJob(job={},coveragePass=1){
  const pass=Math.max(1,Number(coveragePass)||1);
  const lat=Number(job.source_latitude),lon=Number(job.source_longitude);
  const population=Number(job.source_city_population||job.source_population||0);
  if(pass<8||population<10000||!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180) return null;
  let hash=0;
  for(const ch of String((job.partition_state||"")+"|"+(job.partition_city||"")+"|"+(job.partition_zip||job.source_zip||""))) hash=(hash*31+ch.charCodeAt(0))>>>0;
  const cell=(hash+Math.max(0,pass-8))%8;
  const angle=(Math.PI*2*cell)/8;
  const distanceKm=population>=300000?12:population>=100000?9.5:population>=50000?7.5:population>=25000?5.5:3.5;
  const latOffset=(distanceKm/111)*Math.cos(angle);
  const lonScale=Math.max(0.2,Math.cos(lat*Math.PI/180));
  const lonOffset=(distanceKm/(111*lonScale))*Math.sin(angle);
  const centerLat=Math.max(-89.9,Math.min(89.9,lat+latOffset));
  const centerLon=Math.max(-179.9,Math.min(179.9,lon+lonOffset));
  const zoom=population>=300000?12:population>=50000?13:14;
  return {lat:centerLat,lon:centerLon,zoom,radius:Math.round((distanceKm+4)*1000),cell,distanceKm};
}
async function orderVariantsByNetNewYield(redis,variants=[]){
  if(variants.length<2) return variants;
  const families=variants.map(queryFamily);
  const [attemptsRows,newRows,dupRows]=await Promise.all([
    redis.hmGet("recover:yield:query:attempts",families),
    redis.hmGet("recover:yield:query:new",families),
    redis.hmGet("recover:yield:query:duplicates",families),
  ]);
  const ranked=variants.map((query,i)=>{
    const attempts=Number(attemptsRows?.[i]||0);
    const netNew=Number(newRows?.[i]||0);
    const duplicates=Number(dupRows?.[i]||0);
    const avgNew=attempts?netNew/attempts:0;
    const dupRate=(netNew+duplicates)?duplicates/(netNew+duplicates):0;
    const saturated=(attempts>=6 && avgNew<0.35 && dupRate>0.75) || (attempts>=12 && avgNew<0.75 && dupRate>0.90);
    // Prefer demonstrated permanent net-new yield, while retiring search
    // families that have repeatedly produced almost nothing but duplicates.
    const score=attempts===0 ? 3.5 : (avgNew*20)-(dupRate*2)+(attempts<4?1:0);
    return {query,score,attempts,saturated};
  });
  const active=ranked.filter(x=>!x.saturated);
  const pool=active.length ? active : ranked
    .sort((a,b)=>a.attempts-b.attempts||b.score-a.score)
    .slice(0,Math.min(3,ranked.length));
  return pool
    .sort((a,b)=>b.score-a.score||a.attempts-b.attempts)
    .map(x=>x.query);
}
async function recordQueryYield(redis,queries=[],stats={},seed="",coveragePass=""){
  const families=[...new Set((queries||[]).map(queryFamily).filter(Boolean))];
  if(!families.length) return;
  const netNew=Math.max(0,Number(stats.newAdded||0));
  const duplicates=Math.max(0,Number(stats.duplicates||0));
  let hash=0;
  for(const ch of String(seed||"")) hash=(hash*31+ch.charCodeAt(0))>>>0;
  const offset=families.length ? hash%families.length : 0;
  const baseNew=Math.floor(netNew/families.length), remNew=netNew%families.length;
  const baseDup=Math.floor(duplicates/families.length), remDup=duplicates%families.length;
  for(let i=0;i<families.length;i++){
    const family=families[i];
    const rotated=(i-offset+families.length)%families.length;
    const newShare=baseNew+(rotated<remNew?1:0);
    const dupShare=baseDup+(rotated<remDup?1:0);
    const passNum=Number(String(coveragePass||"").match(/p(\d+)$/)?.[1]||0);
    const ops=[
      redis.hIncrBy("recover:yield:query:attempts",family,1),
      redis.hIncrBy("recover:yield:query:new",family,newShare),
      redis.hIncrBy("recover:yield:query:duplicates",family,dupShare),
    ];
    if(passNum>0){
      ops.push(
        redis.hIncrBy(`recover:yield:query:p${passNum}:attempts`,family,1),
        redis.hIncrBy(`recover:yield:query:p${passNum}:new`,family,newShare),
        redis.hIncrBy(`recover:yield:query:p${passNum}:duplicates`,family,dupShare),
      );
    }
    await Promise.all(ops);
  }
}

async function dataforgeScrape(urls) {
  if (!DATAFORGE_BASE_URL || !urls.length) return [];
  const headers={"content-type":"application/json"};
  if (DATAFORGE_API_TOKEN) headers.authorization=`Bearer ${DATAFORGE_API_TOKEN}`;
  const body=await withRetry("DataForge scrape", () => fetchJson(`${DATAFORGE_BASE_URL}/scrape`,{
    method:"POST",headers,body:JSON.stringify({urls,max_concurrent:25})
  },120000));
  return body?.results||[];
}

const jobKey=id=>`recover:acq:${id}`;
const resultsKey=id=>`recover:acq:${id}:results`;
const rawKey=id=>`recover:acq:${id}:raw`;
const leaseKey=id=>`recover:acq:${id}:lease`;

async function saveJob(job) {
  job.updated_at=new Date().toISOString();
  await redis.set(jobKey(job.id),JSON.stringify(job),{EX:JOB_TTL});
  await redis.sAdd("recover:acq:index",job.id);
}
async function loadList(key) {
  const rows=await redis.lRange(key,0,-1);
  return rows.map(x=>{try{return JSON.parse(x)}catch{return null}}).filter(Boolean);
}
async function replaceList(key,values,ttlSeconds) {
  await redis.del(key);
  for (let i=0;i<values.length;i+=200) {
    const chunk=values.slice(i,i+200).map(x=>JSON.stringify(x));
    if (chunk.length) await redis.rPush(key,chunk);
  }
  if (values.length) await redis.expire(key,ttlSeconds);
}
async function deleteRawForJob(id) {
  try {
    await redis.del(rawKey(id));
  } catch (error) {
    console.warn("Acquisition raw cleanup failed", id, error.message);
  }
}
const NY_PRIORITY_QUEUE="recover:acquisition:queue:ny-priority";
const ACTIVE_QUEUE="recover:acquisition:queue";
const PAUSED_NATIONAL_QUEUE="recover:acquisition:queue:paused-national";
const PAUSED_NY_SURPLUS_QUEUE="recover:acquisition:queue:paused-ny-surplus";
const PAUSED_LEGACY_NATIONAL_QUEUE="recover:acquisition:queue:paused-legacy-national-v1";
const NY_SCOPE_SET="recover:leadstore:ny-home-comfort";
const NY_FIRST_MILESTONE=Number(process.env.NY_FIRST_MILESTONE||1000);

async function queueForJob(job) {
  const industry=String(job?.industry||"");
  const batchId=String(job?.batch_id||"");
  const isFastNy=industry==="HOME_COMFORT_TRADES" ||
    batchId==="ny-home-comfort-fast-1000-2026-09-09" ||
    batchId==="ny-home-comfort-fast-pass2-2026-09-09";

  if (isFastNy) return NY_PRIORITY_QUEUE;

  // Nationwide v2 is an explicit phase transition. Do not send its retries or
  // recovered jobs back behind the obsolete NY-first milestone gate.
  if (String(job?.search_profile||"")==="core-home-service" ||
      String(job?.coverage_pass||"").startsWith("us-core-v2-") ||
      String(batchId).startsWith("us-core-home-service-100k-v2")) {
    return ACTIVE_QUEUE;
  }

  let nyScoped=0;
  try { nyScoped=await redis.sCard(NY_SCOPE_SET); } catch {}
  return nyScoped<NY_FIRST_MILESTONE ? PAUSED_NATIONAL_QUEUE : ACTIVE_QUEUE;
}

async function enqueueUnique(id, jobOverride=null) {
  const lockKey=`recover:acquisition:enqueue-lock:${id}`;
  const lockToken=randomUUID();
  const locked=await redis.set(lockKey,lockToken,{NX:true,EX:15});
  if (!locked) return false;

  try {
    let job=jobOverride;
    if (!job) {
      const raw=await redis.get(jobKey(id));
      if (raw) {
        try { job=JSON.parse(raw); } catch {}
      }
    }

    const queueKey=await queueForJob(job);
    const allQueues=[NY_PRIORITY_QUEUE,ACTIVE_QUEUE,PAUSED_NATIONAL_QUEUE];

    // A queued acquisition must exist in exactly one queue.
    for (const key of allQueues) {
      await redis.lRem(key,0,String(id));
    }
    await redis.lPush(queueKey,String(id));
    return true;
  } finally {
    try {
      const owner=await redis.get(lockKey);
      if (owner===lockToken) await redis.del(lockKey);
    } catch {}
  }
}

async function waitForMaps(jobId, acquisition, mapsBase) {
  const fastProfile=isFastHomeServiceJob(acquisition);
  const deadline=Date.now()+(fastProfile ? 90*1000 : 20*60*1000);
  while (Date.now()<deadline) {
    if (shuttingDown) throw new Error("worker shutting down");
    let status;
    try {
      status=await withRetry("Maps status", () => fetchJson(`${mapsBase}/api/v1/jobs/${encodeURIComponent(jobId)}`,{},30000));
    } catch (error) {
      const msg=String(error?.message||error);
      if (/\b404\b|not found/i.test(msg)) {
        throw new Error(`Maps job ${jobId} lost after runtime restart`);
      }
      throw error;
    }
    acquisition.current_maps_status=mapsStatus(status)||"unknown";
    await saveJob(acquisition);
    if (mapsTerminal(status)) return status;
    if (mapsFailed(status)) throw new Error(`Maps job ${jobId} failed: ${mapsStatus(status)}`);
    await sleep(String(acquisition?.search_profile||'')==='core-home-service' ? Math.min(POLL_MS,3000) : POLL_MS);
  }
  if (fastProfile) await markMapsLaneUnavailable(mapsBase,75);
  throw new Error(`Maps job ${jobId} timed out`);
}

async function processAcquisition(id) {
  const leaseToken = randomUUID();
  const acquired = await redis.set(leaseKey(id), leaseToken, { NX:true, EX:LEASE_SECONDS });
  if (!acquired) {
    console.log("Acquisition lease busy; skipping duplicate queue item", id);
    return;
  }

  currentJobId = id;
  const heartbeat = setInterval(async () => {
    try {
      const owner = await redis.get(leaseKey(id));
      if (owner === leaseToken) await redis.expire(leaseKey(id), LEASE_SECONDS);
    } catch (error) {
      console.warn("Lease heartbeat failed", id, error.message);
    }
  }, 30000);
  heartbeat.unref?.();

  console.log("Acquisition start", id);
  const raw=await redis.get(jobKey(id));
  if (!raw) {
    clearInterval(heartbeat);
    await redis.del(leaseKey(id));
    currentJobId = null;
    return;
  }
  const job=JSON.parse(raw);
  if (String(job.search_profile||"")==="core-home-service") {
    // Normalize legacy queued nationwide jobs at consume time so old backlog
    // uses the same phone-only, family-specific contract as newly seeded jobs.
    job.require_phone=true;
    job.require_contact=true;
    if (!String(job.query_family||"").trim() && String(job.service_query_label||"").trim()) {
      job.query_family=String(job.service_query_label).trim();
    }
  }
  if (["complete","partial_complete"].includes(job.status)) {
    clearInterval(heartbeat);
    await redis.del(leaseKey(id));
    currentJobId = null;
    return;
  }

  job.status="running";
  job.started_at=job.started_at||new Date().toISOString();
  await saveJob(job);
  await markCoverage(redis, job, "running", {started_at:job.started_at});

  let allRaw=await loadList(rawKey(id));
  const enrichmentCache=new Map();
  let previousStored=(await loadList(resultsKey(id))).length;
  let stagnantRounds=0;

  try {
    let variants=queryVariants(job.industry,job.location);
    const requestedFamily=normalizeText(job.query_family||"");
    if (isFastHomeServiceJob(job) && requestedFamily) {
      const exact=variants.find(query=>queryFamily(query)===requestedFamily);
      variants=exact ? [exact] : [`${job.query_family} in ${job.location}`];
      console.log(JSON.stringify({event:"query_family_slice",acquisition_id:job.id,coverage_pass:job.coverage_pass,location:job.location,query_family:job.query_family}));
    } else if (isFastHomeServiceJob(job)) {
      variants=await orderVariantsByNetNewYield(redis,variants);
    }
    const configuredMaxRounds=Number(job.max_rounds||12);
    const isFastHomeService=isFastHomeServiceJob(job);
    if (isFastHomeService && variants.length>2) {
      let hash=0;
      const querySeed=`${String(job.location||job.id||"")}|${String(job.coverage_pass||"pass1")}`;
      for (const ch of querySeed) hash=(hash*31+ch.charCodeAt(0))>>>0;
      const passNum=Number(String(job.coverage_pass||"").match(/p(\\d+)$/)?.[1]||1);
      const bundleTarget=passNum>=4 ? 4 : 3;
      const bundleCount=configuredMaxRounds===1 ? Math.min(bundleTarget,variants.length) : Math.min(3,variants.length);
      const exploitCount=passNum>=4 ? Math.min(1,bundleCount) : Math.min(2,bundleCount);
      const chosen=variants.slice(0,exploitCount);
      const explorationPool=variants.slice(exploitCount);
      if(explorationPool.length){
        const needed=bundleCount-chosen.length;
        for(let i=0;i<needed;i++){
          // Spread exploration across the ranked list instead of choosing
          // adjacent near-duplicate query families.
          const segmentStart=Math.floor((i*explorationPool.length)/Math.max(1,needed));
          const segmentEnd=Math.max(segmentStart+1,Math.floor(((i+1)*explorationPool.length)/Math.max(1,needed)));
          const width=Math.max(1,segmentEnd-segmentStart);
          chosen.push(explorationPool[segmentStart+((hash+i)%width)]);
        }
      }
      variants=[...new Set(chosen)].slice(0,bundleCount);
    }
    const maxRounds=Math.min(isFastHomeService ? Math.min(2,configuredMaxRounds) : configuredMaxRounds,variants.length);

    for (let round=Number(job.round||0); round<maxRounds; round++) {
      job.round=round;
      job.rounds_completed=round;
      job.current_query=variants[round];
      job.phase="maps";
      await saveJob(job);

      const currentCoveragePass=Number(String(job.coverage_pass||"").match(/p(\d+)$/)?.[1]||1);
      const densityPopulation=Number(job.source_city_population||job.source_population||0);
      const denseArea=densityPopulation>=10000;
      const fastNyDepthCap=isFastHomeService
        ? (currentCoveragePass>=5 ? (denseArea?12:7) : (currentCoveragePass>=3?(denseArea?9:6):6))
        : MAPS_ROUND_DEPTH_CAP;
      const fastNyMaxTime=isFastHomeService
        ? (currentCoveragePass>=5 ? (denseArea?150:90) : (currentCoveragePass>=3?90:60))
        : MAPS_ROUND_MAX_TIME_SECONDS;
      let mapsKeywords=(isFastHomeService && configuredMaxRounds===1) ? variants : [variants[round]];
      const geoBias=isFastHomeService?geoBiasForJob(job,currentCoveragePass):null;
      if(geoBias && String(job.query_family||"").trim()){
        // With a coordinate-biased search, omit "in City, ST" so Maps ranks
        // around the selected cell instead of reverting to the city-wide list.
        mapsKeywords=[String(job.query_family).trim()];
      }
      job.current_query_families=mapsKeywords.map(queryFamily);
      const geoFastMode=Boolean(geoBias && String(process.env.ACQUISITION_GEO_FAST_MODE||"")==="1");
      const mapsPayload={
        name:`Recover acquisition ${id} round ${round+1}`,
        keywords:mapsKeywords,
        depth:geoBias?Math.min(10,Math.max(Number(job.depth||10),10)):Math.min(Number(job.depth||10), fastNyDepthCap),
        max_time:fastNyMaxTime,
        extra_reviews:false,
        lang:"en",
        ...(geoBias?{
          lat:String(geoBias.lat.toFixed(6)),
          lon:String(geoBias.lon.toFixed(6)),
          zoom:geoBias.zoom,
          radius:geoBias.radius,
          fast_mode:geoFastMode
        }:{})
      };
      if(geoBias) console.log(JSON.stringify({
        event:"maps_geo_cell",acquisition_id:id,coverage_pass:job.coverage_pass,
        location:job.location,query_family:job.query_family,cell:geoBias.cell,
        lat:Number(geoBias.lat.toFixed(5)),lon:Number(geoBias.lon.toFixed(5)),
        zoom:geoBias.zoom,radius:geoBias.radius,fastMode:geoFastMode
      }));
      const {mapsBase,create}=await createMapsJobWithFailover(id,mapsPayload);
      job.current_maps_base_url=mapsBase;
      console.log("Acquisition maps start", id, "round", round+1, variants[round], "via", mapsBase);
      const mapsJobId=String(create?.id||create?.job_id||create?.job?.id||"");
      if (!mapsJobId) throw new Error("Maps backend did not return a job id");
      job.current_maps_job_id=mapsJobId;
      job.maps_jobs=[...(job.maps_jobs||[]),{id:mapsJobId,query:variants[round],round,base_url:mapsBase}];
      await saveJob(job);

      try {
        await waitForMaps(mapsJobId,job,mapsBase);
      } catch (error) {
        const mapsError=String(error?.message||error);
        const explicitJobTimeout=/Maps job .* timed out|Maps job .* timeout|timed out$/i.test(mapsError);
        const transportFailed=!explicitJobTimeout && isRetryableError(error);
        if (/timed out|lost after runtime restart|Maps job .* failed:/i.test(mapsError) || transportFailed) {
          const lost=/lost after runtime restart/i.test(mapsError);
          const jobFailed=/Maps job .* failed:/i.test(mapsError);
          const laneFailed=transportFailed || lost;
          // A scraper job can fail for a query/location-specific reason while
          // the Maps service itself is healthy. Only cool the whole lane for
          // transport/lost-state failures.
          if (laneFailed) await markMapsLaneUnavailable(mapsBase);
          job.maps_jobs[job.maps_jobs.length-1].status=lost?"lost_after_restart":laneFailed?"backend_unavailable":jobFailed?"job_failed":"timed_out";
          job.maps_jobs[job.maps_jobs.length-1].error=mapsError;
          job.phase=lost?"maps_restart_continue":laneFailed?"maps_backend_unavailable_continue":jobFailed?"maps_job_failed_continue":"maps_timeout_continue";
          await saveJob(job);
          console.warn(
            lost?"Acquisition Maps state reset; continuing next round":
            laneFailed?"Acquisition Maps lane unavailable; continuing next round":
            jobFailed?"Acquisition Maps job failed; retrying another lane":
            "Acquisition maps timeout; continuing next round",
            id,mapsJobId,mapsError
          );
          job.round_retry_counts=job.round_retry_counts||{};
          const retryCount=Number(job.round_retry_counts[String(round)]||0);
          if (isFastHomeService && retryCount<1) {
            job.round_retry_counts[String(round)]=retryCount+1;
            await saveJob(job);
            round--;
          }
          continue;
        }
        throw error;
      }
      console.log("Acquisition maps done", id, mapsJobId);
      let csv;
      try {
        csv=await withRetry("Maps CSV download", () => fetchText(`${mapsBase}/api/v1/jobs/${encodeURIComponent(mapsJobId)}/download`,{},60000));
      } catch (error) {
        if (!isRetryableError(error)) throw error;
        await markMapsLaneUnavailable(mapsBase);
        job.maps_jobs[job.maps_jobs.length-1].status="download_unavailable";
        job.maps_jobs[job.maps_jobs.length-1].error=String(error?.message||error);
        job.phase="maps_download_unavailable_continue";
        await saveJob(job);
        console.warn("Acquisition Maps download unavailable; continuing next round",id,mapsJobId,error.message);
        job.round_retry_counts=job.round_retry_counts||{};
        const retryCount=Number(job.round_retry_counts[String(round)]||0);
        if (isFastHomeService && retryCount<1) {
          job.round_retry_counts[String(round)]=retryCount+1;
          await saveJob(job);
          round--;
        }
        continue;
      }
      const roundRows=parseCsv(csv);
      console.log("Acquisition CSV parsed", id, "rows", roundRows.length);
      allRaw.push(...roundRows);
      allRaw=dedupeRecords(allRaw);
      await replaceList(rawKey(id),allRaw,RAW_TTL_SECONDS);

      job.raw_count=roundRows.length+(job.raw_count||0);
      job.unique_count=allRaw.length;

      let leads;
      if (job.require_no_website) {
        // For no-website campaigns, domain crawling/enrichment is wasted work:
        // any lead with a website will be rejected, and no-domain leads cannot
        // benefit from domain enrichment. Go straight to qualification.
        job.phase="qualification";
        await saveJob(job);
        console.log("Acquisition enrichment skipped for no-website campaign", id);
        leads=allRaw;
      } else {
        job.phase="enrichment";
        await saveJob(job);

        const websites=[...new Set(allRaw.map(x=>x.website).filter(Boolean))];
        const newUrls=websites.filter(url=>!enrichmentCache.has(normalizeDomain(url)));
        console.log("Acquisition enrichment start", id, "urls", newUrls.length);
        for (let i=0;i<newUrls.length;i+=100) {
          try {
            const enriched=await dataforgeScrape(newUrls.slice(i,i+100));
            for (const item of enriched) enrichmentCache.set(normalizeDomain(item.url||""),item);
          } catch (e) {
            console.warn("DataForge batch failed",e.message);
          }
        }

        console.log("Acquisition enrichment done", id, "enriched_domains", enrichmentCache.size);
        leads=allRaw.map(lead=>{
          const e=enrichmentCache.get(normalizeDomain(lead.website||""));
          if (!e) return lead;
          const domain=normalizeDomain(lead.website||"");
          const sameDomainEmails=Array.isArray(e.emails)
            ? e.emails.filter(email=>normalizeDomain(String(email).split("@")[1]||"")===domain)
            : [];
          return {
            ...lead,
            emails:sameDomainEmails.length?sameDomainEmails:lead.emails,
            tech_stack:e.tech_stack||[],
            cms_detected:e.cms_detected||null,
            ssl_valid:e.ssl_valid,
            site_speed_ms:e.site_speed_ms,
            website_status:e.status
          };
        });
        job.phase="qualification";
      }

      const funnel=qualificationFunnel(leads,job);
      console.log(JSON.stringify({event:"qualification_funnel",acquisition_id:id,location:job.location,coverage_pass:job.coverage_pass,...funnel}));

      leads=locationCandidateSet(leads,job)
        .filter(lead=>matchesRequestedIndustry(lead,job.industry))
        .filter(lead=>!job.require_no_website||!isOwnedBusinessWebsite(lead.website))
        .filter(lead=>!job.require_phone||!!lead.phone)
        .filter(lead=>!job.require_email||normalizeEmails(lead.emails||lead.email||"").length>0)
        .filter(lead=>!job.require_contact||!!lead.phone||normalizeEmails(lead.emails||lead.email||"").length>0)
        .filter(lead=>job.include_no_website!==false||!!lead.website)
        .map(lead=>({...lead,qualification:scoreLead(lead)}))
        .filter(lead=>lead.qualification.score>=Number(job.min_score||0))
        .sort((a,b)=>b.qualification.score-a.qualification.score);

      job.qualified_count=leads.length;
      job.rounds_completed=round+1;

      const compactQualified=leads.map(compactLead);
      const existingPersisted=await loadList(resultsKey(id));
      const persisted=upsertQualifiedLeads(existingPersisted,compactQualified);
      await replaceList(resultsKey(id),persisted,RESULT_TTL_SECONDS);
      const permanentStats=await persistPermanentQualified(redis, job, leads);
      await recordQueryYield(redis,job.current_query_families||[job.current_query],permanentStats,job.id,job.coverage_pass);
      job.stored_count=persisted.length;
      job.permanent_new_count=Number(job.permanent_new_count||0)+permanentStats.newAdded;
      job.permanent_duplicate_count=Number(job.permanent_duplicate_count||0)+permanentStats.duplicates;
      const addedThisRound=Math.max(0,job.stored_count-previousStored);
      const globallyStagnant=permanentStats.newAdded===0 && permanentStats.duplicates>0;
      stagnantRounds=globallyStagnant ? stagnantRounds+1 : 0;
      previousStored=job.stored_count;
      console.log("Acquisition qualified", id, "count", leads.length, "stored", job.stored_count, "added", addedThisRound, "global_new", permanentStats.newAdded, "global_dup", permanentStats.duplicates, "target", job.target);
      await saveJob(job);

      if (leads.length>=Number(job.target)) {
        const finalLeads=leads.slice(0,Number(job.target)).map(compactLead);
        await replaceList(resultsKey(id),finalLeads,RESULT_TTL_SECONDS);
        job.status="complete";
        job.phase="complete";
        job.stored_count=finalLeads.length;
        job.completed_at=new Date().toISOString();
        await recordAreaYield(redis,job);
        await saveJob(job);
        await markCoverage(redis, job, "target_reached", {reason:"target_reached",permanent_new_count:job.permanent_new_count||0,permanent_duplicate_count:job.permanent_duplicate_count||0});
        await deleteRawForJob(id);
        console.log("Acquisition complete", id, "stored", finalLeads.length);
        return;
      }

      // Fast NY milestone mode: do not waste rounds on a ZIP that has stopped yielding.
      // Require at least two completed rounds so the first query still gets one follow-up.
      if ((round>=1 && stagnantRounds>=1) || (isFastHomeService && permanentStats.newAdded===0 && permanentStats.duplicates>=5)) {
        job.status="partial_complete";
        job.phase="complete";
        job.reason="stagnant_round_exit";
        job.completed_at=new Date().toISOString();
        await recordAreaYield(redis,job);
        await saveJob(job);
        await markCoverage(redis, job, "exhausted", {reason:"stagnant_round_exit",permanent_new_count:job.permanent_new_count||0,permanent_duplicate_count:job.permanent_duplicate_count||0});
        await deleteRawForJob(id);
        console.log("Acquisition early exit stagnant", id, "stored", job.stored_count, "after_round", round+1);
        return;
      }
    }

    let leads=locationCandidateSet(allRaw,job)
      .filter(lead=>matchesRequestedIndustry(lead,job.industry))
      .map(lead=>({...lead,qualification:scoreLead(lead)}))
      .filter(lead=>lead.qualification.score>=Number(job.min_score||0))
      .filter(lead=>!job.require_phone||!!lead.phone)
      .filter(lead=>!job.require_email||normalizeEmails(lead.emails||lead.email||"").length>0)
      .filter(lead=>!job.require_contact||!!lead.phone||normalizeEmails(lead.emails||lead.email||"").length>0)
      .filter(lead=>job.include_no_website!==false||!!lead.website)
      .filter(lead=>!job.require_no_website||!isOwnedBusinessWebsite(lead.website))
      .sort((a,b)=>b.qualification.score-a.qualification.score)
      .map(compactLead);

    const existingPersisted=await loadList(resultsKey(id));
    const persisted=upsertQualifiedLeads(existingPersisted,leads);
    await replaceList(resultsKey(id),persisted,RESULT_TTL_SECONDS);
    job.status="partial_complete";
    job.phase="complete";
    job.qualified_count=leads.length;
    job.stored_count=persisted.length;
    job.reason="max_rounds_reached";
    job.completed_at=new Date().toISOString();
    await recordAreaYield(redis,job);
    await saveJob(job);
    await markCoverage(redis, job, "exhausted", {reason:"max_rounds_reached",permanent_new_count:job.permanent_new_count||0,permanent_duplicate_count:job.permanent_duplicate_count||0});
    await deleteRawForJob(id);
    console.log("Acquisition partial_complete", id, "stored", leads.length);
  } catch (error) {
    if (shuttingDown || String(error?.message||error).includes("worker shutting down")) {
      job.status="queued";
      job.phase="interrupted_requeued";
      job.error=null;
      await saveJob(job);
      await enqueueUnique(id,job);
      console.warn("Acquisition interrupted and requeued", id);
    } else {
      job.status="failed";
      job.phase="failed";
      job.error=String(error?.message||error);
      await saveJob(job);
      console.error("Acquisition failed",id,error);
    }
  } finally {
    clearInterval(heartbeat);
    try {
      const owner = await redis.get(leaseKey(id));
      if (owner === leaseToken) await redis.del(leaseKey(id));
    } catch {}
    currentJobId = null;
  }
}

async function recoverInterrupted() {
  const lockKey="recover:worker:global-recovery-lock";
  const lockToken=randomUUID();
  const locked=await redis.set(lockKey,lockToken,{NX:true,EX:90});
  if(!locked){
    console.log(JSON.stringify({event:"recover_interrupted_skipped",reason:"recovery_lock_busy"}));
    return;
  }
  try {
    const ids=await redis.sMembers("recover:acq:index");
    const now=Date.now();
    const [pausedNational,pausedNySurplus,pausedLegacy]=await Promise.all([
      redis.lRange(PAUSED_NATIONAL_QUEUE,0,-1),
      redis.lRange(PAUSED_NY_SURPLUS_QUEUE,0,-1),
      redis.lRange(PAUSED_LEGACY_NATIONAL_QUEUE,0,-1)
    ]);
    const parked=new Set([...pausedNational,...pausedNySurplus,...pausedLegacy].map(String));

    let recovered=0, skippedParked=0;
    for (const id of ids) {
      const raw=await redis.get(jobKey(id));
      if (!raw) continue;
      try {
        const job=JSON.parse(raw);
        if (parked.has(String(id))) {
          if (["queued","running"].includes(String(job.status||""))) {
            job.status="parked";
            job.phase="parked_queue_preserved";
            await saveJob(job);
          }
          skippedParked++;
          continue;
        }
        if (!["queued","running"].includes(job.status)) continue;
        const updated=Date.parse(job.updated_at||job.created_at||0);
        if (!updated || now-updated>120000) {
          job.status="queued";
          job.phase="requeued_after_restart";
          await saveJob(job);
          await enqueueUnique(id,job);
          recovered++;
        }
      } catch {}
    }
    console.log(JSON.stringify({event:"recover_interrupted_complete",recovered,skippedParked,parkedSnapshot:parked.size}));
  } finally {
    try {
      const owner=await redis.get(lockKey);
      if(owner===lockToken) await redis.del(lockKey);
    } catch {}
  }
}

function beginShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Acquisition worker received", signal, "current_job", currentJobId || "none");
}
process.on("SIGTERM", () => beginShutdown("SIGTERM"));
process.on("SIGINT", () => beginShutdown("SIGINT"));

await redis.connect();
console.log("Acquisition worker connected to Redis");

if(String(process.env.ACQUISITION_WORKER_STANDBY||"").toLowerCase()==="true"){
  console.log("Acquisition worker standby mode enabled; not consuming queue");
  while(!shuttingDown) await sleep(30000);
  try { await redis.quit(); } catch {}
  console.log("Acquisition worker standby stopped cleanly");
  process.exit(0);
}

await recoverInterrupted();

while (!shuttingDown) {
  try {
    const item=await redis.brPop(["recover:acquisition:queue:ny-priority","recover:acquisition:queue"],5);
    if (shuttingDown) break;
    const id=item?.element||item;
    if (!id) continue;
    await processAcquisition(String(id));
  } catch (error) {
    console.error("Worker loop error",error);
    await sleep(5000);
  }
}


try { await redis.quit(); } catch {}
console.log("Acquisition worker stopped cleanly");

// deployment trigger: ny-priority-fix

// restart trigger after NY milestone queue switch 2026-09-10

// classifier refresh trigger 2026-09-10

// recycle workers to release stale NY round-2 jobs and prioritize nationwide v2 2026-09-10
