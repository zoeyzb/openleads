import { createClient } from "redis";
import { randomUUID } from "node:crypto";

const REDIS_URL = process.env.ACQUISITION_REDIS_URL || process.env.REDIS_URL || "";
const MAPS_BASE_URL = (process.env.MAPS_BASE_URL || "").replace(/\/$/, "");
const DATAFORGE_BASE_URL = (process.env.DATAFORGE_BASE_URL || "").replace(/\/$/, "");
const DATAFORGE_API_TOKEN = process.env.DATAFORGE_API_TOKEN || "";
const JOB_TTL = Number(process.env.ACQUISITION_TTL_SECONDS || 604800);
const POLL_MS = Number(process.env.ACQUISITION_POLL_MS || 10000);
const LEASE_SECONDS = Number(process.env.ACQUISITION_LEASE_SECONDS || 180);
const RETRY_ATTEMPTS = Number(process.env.ACQUISITION_RETRY_ATTEMPTS || 3);
let shuttingDown = false;
let currentJobId = null;

if (!REDIS_URL) throw new Error("ACQUISITION_REDIS_URL is required");
if (!MAPS_BASE_URL) throw new Error("MAPS_BASE_URL is required");

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
    const keys=[
      lead.place_id && "place:"+lead.place_id,
      lead.cid && "cid:"+lead.cid,
      normalizeDomain(lead.website||lead.domain||"") && "domain:"+normalizeDomain(lead.website||lead.domain||""),
      normalizePhone(lead.phone||"") && "phone:"+normalizePhone(lead.phone||""),
      "na:"+normalizeText((lead.name||lead.title||"")+"|"+(lead.address||""))
    ].filter(Boolean);
    if (keys.some(k=>seen.has(k))) continue;
    keys.forEach(k=>seen.add(k)); out.push(lead);
  }
  return out;
}
function matchesRequestedIndustry(lead, industry) {
  const target=normalizeText(industry||"");
  const hay=normalizeText((lead.category||"")+" "+(lead.title||lead.name||"")+" "+(lead.descriptions||""));
  if (!target) return true;
  if (/hvac|heating|air conditioning|cooling/.test(target)) return /hvac|heating|cooling|air conditioning|mechanical contractor/.test(hay);
  if (/roof/.test(target)) return /roof/.test(hay);
  if (/plumb/.test(target)) return /plumb/.test(hay);
  if (/electric/.test(target)) return /electric/.test(hay);
  if (/landscap/.test(target)) return /landscap|lawn|tree service/.test(hay);
  if (/dent/.test(target)) return /dent/.test(hay);
  if (/restaurant|food/.test(target)) return /restaurant|food|cafe|grill|kitchen/.test(hay);
  const tokens=target.split(" ").filter(x=>x.length>=4);
  return tokens.length===0 || tokens.some(t=>hay.includes(t));
}
function scoreLead(lead) {
  let score=0; const reasons=[]; const add=(p,r)=>{score+=p;reasons.push({points:p,reason:r});};
  const category=normalizeText(lead.category||lead.industry||"");
  if (/hvac|heating|air conditioning|plumb|roof|electric/.test(category)) add(15,"target local-service category");
  if (!lead.website) add(20,"no website");
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
    website:lead.website||"",
    phone:lead.phone||"",
    emails:normalizeEmails(lead.emails||lead.email||""),
    owner_name:ownerNameFromLead(lead),
    google_maps_url:lead.link||lead.google_maps_url||"",
    place_id:lead.place_id||"",
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
function mapsStatus(job) {
  return String(job?.status||job?.Status||job?.state||job?.State||job?.job?.status||job?.job?.Status||"").toLowerCase();
}
function mapsTerminal(job) { return ["ok","completed","complete","done","finished","success","succeeded"].some(x=>mapsStatus(job).includes(x)); }
function mapsFailed(job) { return ["failed","error","cancelled","canceled"].some(x=>mapsStatus(job).includes(x)); }

const queryVariants=(industry,location)=>[
  `${industry} in ${location}`,
  `${industry} contractor in ${location}`,
  `${industry} service company in ${location}`,
  `${industry} near ${location}`,
  `${industry} company ${location}`,
  `${industry} services ${location}`,
  `${industry} repair in ${location}`,
  `${industry} installation in ${location}`,
  `commercial ${industry} in ${location}`,
  `residential ${industry} in ${location}`,
  `emergency ${industry} in ${location}`,
  `local ${industry} in ${location}`,
  `${industry} maintenance in ${location}`,
  `${industry} specialists in ${location}`,
  `${industry} technicians in ${location}`,
  `${industry} business in ${location}`,
  `${industry} providers in ${location}`,
  `${industry} contractors near ${location}`,
  `${industry} service near ${location}`,
  `${industry} repair near ${location}`
];

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
async function replaceList(key,values) {
  await redis.del(key);
  for (let i=0;i<values.length;i+=200) {
    const chunk=values.slice(i,i+200).map(x=>JSON.stringify(x));
    if (chunk.length) await redis.rPush(key,chunk);
  }
  await redis.expire(key,JOB_TTL);
}

async function waitForMaps(jobId, acquisition) {
  const deadline=Date.now()+20*60*1000;
  while (Date.now()<deadline) {
    if (shuttingDown) throw new Error("worker shutting down");
    const status=await withRetry("Maps status", () => fetchJson(`${MAPS_BASE_URL}/api/v1/jobs/${encodeURIComponent(jobId)}`,{},30000));
    acquisition.current_maps_status=mapsStatus(status)||"unknown";
    await saveJob(acquisition);
    if (mapsTerminal(status)) return status;
    if (mapsFailed(status)) throw new Error(`Maps job ${jobId} failed: ${mapsStatus(status)}`);
    await sleep(POLL_MS);
  }
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
  if (["complete","partial_complete"].includes(job.status)) {
    clearInterval(heartbeat);
    await redis.del(leaseKey(id));
    currentJobId = null;
    return;
  }

  job.status="running";
  job.started_at=job.started_at||new Date().toISOString();
  await saveJob(job);

  let allRaw=await loadList(rawKey(id));
  const enrichmentCache=new Map();

  try {
    const variants=queryVariants(job.industry,job.location);
    const maxRounds=Math.min(Number(job.max_rounds||12),variants.length);

    for (let round=Number(job.round||0); round<maxRounds; round++) {
      job.round=round;
      job.rounds_completed=round;
      job.current_query=variants[round];
      job.phase="maps";
      await saveJob(job);

      console.log("Acquisition maps start", id, "round", round+1, variants[round]);
      const create=await withRetry("Maps create job", () => fetchJson(`${MAPS_BASE_URL}/api/v1/jobs`,{
        method:"POST",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({
          name:`Recover acquisition ${id} round ${round+1}`,
          keywords:[variants[round]],
          depth:Number(job.depth||10),
          max_time:900,
          extra_reviews:false,
          lang:"en"
        })
      },30000));
      const mapsJobId=String(create?.id||create?.job_id||create?.job?.id||"");
      if (!mapsJobId) throw new Error("Maps backend did not return a job id");
      job.current_maps_job_id=mapsJobId;
      job.maps_jobs=[...(job.maps_jobs||[]),{id:mapsJobId,query:variants[round],round}];
      await saveJob(job);

      await waitForMaps(mapsJobId,job);
      console.log("Acquisition maps done", id, mapsJobId);
      const csv=await withRetry("Maps CSV download", () => fetchText(`${MAPS_BASE_URL}/api/v1/jobs/${encodeURIComponent(mapsJobId)}/download`,{},60000));
      const roundRows=parseCsv(csv);
      console.log("Acquisition CSV parsed", id, "rows", roundRows.length);
      allRaw.push(...roundRows);
      allRaw=dedupeRecords(allRaw);
      await replaceList(rawKey(id),allRaw);

      job.raw_count=roundRows.length+(job.raw_count||0);
      job.unique_count=allRaw.length;
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
      let leads=allRaw.map(lead=>{
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
      leads=leads
        .filter(lead=>matchesRequestedIndustry(lead,job.industry))
        .map(lead=>({...lead,qualification:scoreLead(lead)}))
        .filter(lead=>lead.qualification.score>=Number(job.min_score||0))
        .filter(lead=>!job.require_phone||!!lead.phone)
        .filter(lead=>!job.require_email||normalizeEmails(lead.emails||lead.email||"").length>0)
        .filter(lead=>job.include_no_website!==false||!!lead.website)
        .sort((a,b)=>b.qualification.score-a.qualification.score);

      job.qualified_count=leads.length;
      job.rounds_completed=round+1;
      console.log("Acquisition qualified", id, "count", leads.length, "target", job.target);
      await saveJob(job);

      if (leads.length>=Number(job.target)) {
        const finalLeads=leads.slice(0,Number(job.target)).map(compactLead);
        await replaceList(resultsKey(id),finalLeads);
        job.status="complete";
        job.phase="complete";
        job.stored_count=finalLeads.length;
        job.completed_at=new Date().toISOString();
        await saveJob(job);
        console.log("Acquisition complete", id, "stored", finalLeads.length);
        return;
      }
    }

    let leads=allRaw
      .filter(lead=>matchesRequestedIndustry(lead,job.industry))
      .map(lead=>({...lead,qualification:scoreLead(lead)}))
      .filter(lead=>lead.qualification.score>=Number(job.min_score||0))
      .filter(lead=>!job.require_phone||!!lead.phone)
      .filter(lead=>!job.require_email||normalizeEmails(lead.emails||lead.email||"").length>0)
      .filter(lead=>job.include_no_website!==false||!!lead.website)
      .sort((a,b)=>b.qualification.score-a.qualification.score)
      .map(compactLead);

    await replaceList(resultsKey(id),leads);
    job.status="partial_complete";
    job.phase="complete";
    job.qualified_count=leads.length;
    job.stored_count=leads.length;
    job.reason="max_rounds_reached";
    job.completed_at=new Date().toISOString();
    await saveJob(job);
    console.log("Acquisition partial_complete", id, "stored", leads.length);
  } catch (error) {
    if (shuttingDown || String(error?.message||error).includes("worker shutting down")) {
      job.status="queued";
      job.phase="interrupted_requeued";
      job.error=null;
      await saveJob(job);
      await redis.lPush("recover:acquisition:queue", id);
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
  const ids=await redis.sMembers("recover:acq:index");
  const now=Date.now();
  for (const id of ids) {
    const raw=await redis.get(jobKey(id));
    if (!raw) continue;
    try {
      const job=JSON.parse(raw);
      if (!["queued","running"].includes(job.status)) continue;
      const updated=Date.parse(job.updated_at||job.created_at||0);
      if (!updated || now-updated>120000) {
        job.status="queued";
        job.phase="requeued_after_restart";
        await saveJob(job);
        await redis.lPush("recover:acquisition:queue",id);
      }
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
await recoverInterrupted();

while (!shuttingDown) {
  try {
    const item=await redis.brPop("recover:acquisition:queue",5);
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
