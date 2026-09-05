import { createServer as createHttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createClient } from "redis";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod/v4";
import { orchestrate as enrichEmail } from "email-enrich";

const PORT = Number(process.env.PORT || 3000);
const MAPS_BASE_URL = (process.env.MAPS_BASE_URL || "").replace(/\/$/, "");
const CRAWL4AI_BASE_URL = (process.env.CRAWL4AI_BASE_URL || "").replace(/\/$/, "");
const CRAWL4AI_API_TOKEN = process.env.CRAWL4AI_API_TOKEN || "";
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
const YOZH_BASE_URL = (process.env.YOZH_BASE_URL || "").replace(/\/$/, "");
const SCRAPLING_MCP_URL = (process.env.SCRAPLING_MCP_URL || "").replace(/\/$/, "");
const SCRAPLING_MCP_TOKEN = process.env.SCRAPLING_MCP_TOKEN || "";
const KEELEAD_BASE_URL = (process.env.KEELEAD_BASE_URL || "").replace(/\/$/, "");
const DATAFORGE_BASE_URL = (process.env.DATAFORGE_BASE_URL || "").replace(/\/$/, "");
const DATAFORGE_API_TOKEN = process.env.DATAFORGE_API_TOKEN || "";
const ACQUISITION_REDIS_URL = process.env.ACQUISITION_REDIS_URL || "";
let acquisitionRedisPromise = null;

async function getAcquisitionRedis() {
  if (!ACQUISITION_REDIS_URL) throw new Error("ACQUISITION_REDIS_URL is not configured");
  if (!acquisitionRedisPromise) {
    acquisitionRedisPromise = (async () => {
      const client = createClient({ url: ACQUISITION_REDIS_URL });
      client.on("error", err => console.error("Acquisition Redis error", err));
      await client.connect();
      return client;
    })();
  }
  return acquisitionRedisPromise;
}

const jsonText = (value) => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value
});

async function fetchJson(url, init = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${JSON.stringify(body)}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}


function parseMcpPayload(text) {
  try { return JSON.parse(text); } catch {}
  const dataLines = String(text).split("\n").filter(line => line.startsWith("data:"));
  for (const line of dataLines.reverse()) {
    try { return JSON.parse(line.slice(5).trim()); } catch {}
  }
  return { raw: text };
}

async function callRemoteMcpTool(url, token, toolName, args = {}) {
  const headers = {
    "content-type": "application/json",
    "accept": "application/json, text/event-stream"
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const initRes = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "recover-scrape-gateway", version: "1.0.0" }
      }
    })
  });
  const initText = await initRes.text();
  if (!initRes.ok) throw new Error(`MCP initialize failed: ${initRes.status} ${initText}`);
  const sessionId = initRes.headers.get("mcp-session-id");
  const sessionHeaders = { ...headers };
  if (sessionId) sessionHeaders["mcp-session-id"] = sessionId;

  await fetch(url, {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
  });

  const callRes = await fetch(url, {
    method: "POST",
    headers: sessionHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: toolName, arguments: args }
    })
  });
  const callText = await callRes.text();
  if (!callRes.ok) throw new Error(`MCP tool call failed: ${callRes.status} ${callText}`);
  return parseMcpPayload(callText);
}


function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else {
      if (ch === '"') quoted = true;
      else if (ch === ',') { row.push(field); field = ""; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ""; }
      else if (ch !== '\r') field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows.shift().map(h => h.trim());
  return rows.filter(r => r.some(v => String(v).trim())).map(r => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = r[i] ?? ""; });
    return obj;
  });
}

function encodeState(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
function decodeState(token) {
  return JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
}

async function fetchText(url, init = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0,500)}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function mapsTerminal(job) {
  const value = String(job?.status || job?.Status || job?.state || job?.State || job?.job?.status || job?.job?.Status || "").toLowerCase();
  return ["ok","completed","complete","done","finished","success","succeeded"].some(x => value.includes(x));
}

function mapsFailed(job) {
  const value = String(job?.status || job?.Status || job?.state || job?.State || job?.job?.status || job?.job?.Status || "").toLowerCase();
  return ["failed","error","cancelled","canceled"].some(x => value.includes(x));
}

function acquisitionQuery(state, round) {
  const base = state.industry + " in " + state.location;
  const variants = [
    base,
    state.industry + " contractor in " + state.location,
    state.industry + " service company in " + state.location,
    state.industry + " near " + state.location,
    state.industry + " company " + state.location,
    state.industry + " services " + state.location
  ];
  return variants[Math.min(round, variants.length - 1)];
}

async function dataforgeScrape(urls) {
  if (!DATAFORGE_BASE_URL || !urls.length) return [];
  const headers = {"content-type":"application/json"};
  if (DATAFORGE_API_TOKEN) headers.authorization = `Bearer ${DATAFORGE_API_TOKEN}`;
  const body = await fetchJson(`${DATAFORGE_BASE_URL}/scrape`, {
    method:"POST", headers, body:JSON.stringify({ urls, max_concurrent:25 })
  }, 120000);
  return body?.results || [];
}

function normalizeDomain(value = "") {
  try {
    const url = value.includes("://") ? new URL(value) : new URL("https://" + value);
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch { return String(value).toLowerCase().replace(/^www\./, "").replace(/\/$/, ""); }
}
function normalizePhone(value = "") { return String(value).replace(/\D/g, "").slice(-10); }
function normalizeText(value = "") { return String(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

function dedupeRecords(records) {
  const seen = new Map();
  const output = [];
  for (const lead of records) {
    const domain = normalizeDomain(lead.website || lead.domain || "");
    const phone = normalizePhone(lead.phone || "");
    const place = String(lead.place_id || lead.cid || lead.data_id || "");
    const nameAddr = normalizeText((lead.name || lead.title || "") + "|" + (lead.address || ""));
    const keys = [place && "place:"+place, domain && "domain:"+domain, phone && "phone:"+phone, nameAddr && "na:"+nameAddr].filter(Boolean);
    const existing = keys.find(k => seen.has(k));
    if (existing) continue;
    const idx = output.length;
    output.push(lead);
    for (const k of keys) seen.set(k, idx);
  }
  return output;
}

function matchesRequestedIndustry(lead, industry) {
  const target = normalizeText(industry || "");
  const haystack = normalizeText(
    (lead.category || "") + " " + (lead.title || lead.name || "") + " " + (lead.descriptions || "")
  );
  if (!target) return true;
  if (/hvac|heating|air conditioning|cooling/.test(target)) {
    return /hvac|heating|cooling|air conditioning|mechanical contractor/.test(haystack);
  }
  if (/roof/.test(target)) return /roof/.test(haystack);
  if (/plumb/.test(target)) return /plumb/.test(haystack);
  if (/electric/.test(target)) return /electric/.test(haystack);
  if (/landscap/.test(target)) return /landscap|lawn|tree service/.test(haystack);
  if (/dent/.test(target)) return /dent/.test(haystack);
  if (/restaurant|food/.test(target)) return /restaurant|food|cafe|grill|kitchen/.test(haystack);
  const tokens = target.split(" ").filter(x => x.length >= 4);
  return tokens.length === 0 || tokens.some(token => haystack.includes(token));
}

function normalizeEmails(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[;,\s]+/);
  return [...new Set(values.map(x => String(x).trim().toLowerCase()).filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))];
}

function ownerNameFromLead(lead) {
  if (lead.owner_name) return String(lead.owner_name);
  if (!lead.owner) return "";
  if (typeof lead.owner === "object") return String(lead.owner.name || "");
  try {
    const parsed = JSON.parse(String(lead.owner));
    return String(parsed?.name || "");
  } catch {
    return "";
  }
}

function compactLead(lead) {
  return {
    name: lead.name || lead.title || "",
    category: lead.category || lead.industry || "",
    address: lead.address || "",
    website: lead.website || "",
    phone: lead.phone || "",
    emails: normalizeEmails(lead.emails || lead.email || ""),
    owner_name: ownerNameFromLead(lead),
    google_maps_url: lead.link || lead.google_maps_url || "",
    place_id: lead.place_id || "",
    review_count: Number(lead.review_count || lead.reviews || 0),
    review_rating: Number(lead.review_rating || lead.rating || 0),
    latitude: lead.latitude ? Number(lead.latitude) : null,
    longitude: lead.longitude ? Number(lead.longitude) : null,
    tech_stack: Array.isArray(lead.tech_stack) ? lead.tech_stack : [],
    cms_detected: lead.cms_detected || null,
    ssl_valid: typeof lead.ssl_valid === "boolean" ? lead.ssl_valid : null,
    site_speed_ms: Number.isFinite(Number(lead.site_speed_ms)) ? Number(lead.site_speed_ms) : null,
    website_status: lead.website_status || null,
    qualification: lead.qualification || null
  };
}

function storeAcquisitionResults(acquisitionId, leads) {
  if (!acquisitionId) return;
  acquisitionResultStore.set(acquisitionId, leads.map(compactLead));
  while (acquisitionResultStore.size > 20) {
    const firstKey = acquisitionResultStore.keys().next().value;
    acquisitionResultStore.delete(firstKey);
  }
}

function scoreLead(lead) {
  let score = 0;
  const reasons = [];
  const add = (points, reason) => { score += points; reasons.push({ points, reason }); };
  const category = normalizeText(lead.category || lead.industry || "");
  if (/hvac|heating|air conditioning|plumb|roof|electric/.test(category)) add(15, "target local-service category");
  if (!lead.website) add(20, "no website");
  if (lead.website && (lead.website_issues || lead.bad_website || lead.outdated_website)) add(15, "website has conversion/quality issues");
  if (lead.website && lead.website_status && lead.website_status !== "ok") add(10, "website fetch/health problem");
  if (lead.website && lead.ssl_valid === false) add(10, "website SSL problem");
  if (lead.website && Number(lead.site_speed_ms || 0) >= 3000) add(10, "slow website");
  const reviews = Number(lead.review_count || lead.reviews || 0);
  if (reviews >= 20) add(10, "20+ reviews");
  if (Number(lead.review_rating || lead.rating || 0) >= 4.2) add(5, "strong rating");
  if (lead.phone) add(10, "phone available");
  if (lead.email || (Array.isArray(lead.emails) && lead.emails.length)) add(10, "email available");
  if (lead.owner_name) add(10, "identified owner/decision-maker signal available");
  if (lead.no_online_booking || lead.booking_missing) add(10, "booking gap");
  if (lead.no_chat) add(5, "chat gap");
  if (lead.missed_call_gap || lead.no_missed_call_automation) add(5, "missed-call automation gap");
  score = Math.min(100, score);
  const tier = score >= 85 ? "hot" : score >= 70 ? "strong" : score >= 50 ? "maybe" : score >= 30 ? "weak" : "reject";
  return { score, tier, reasons };
}

function buildServer() {
  const server = new McpServer(
    { name: "recover-scrape", version: "1.0.0" },
    {
      instructions:
        "Use Recover Scrape for business discovery, Google Maps scraping, website crawling, stealth scraping, public-contact enrichment, deduplication and lead qualification. When the user requests a target number of leads, prefer acquire_qualified_leads, poll acquisition_status by acquisition_id until terminal, then page results with acquisition_results. Prefer maps_start_job for one-off local-business discovery. For websites, try crawl_website first; if blocked or highly dynamic, use scrapling_stealth_fetch; for durable queued browser work use yozh_start_scrape. Use enrich_email for public professional-email enrichment, dedupe_leads before returning large lead sets, and qualify_leads to rank prospects. Never claim an email, owner identity, or lead attribute is verified unless returned evidence supports it."
    }
  );

  server.registerTool("recover_scrape_status", {
    description: "Check which Recover Scrape backends are configured and reachable."
  }, async () => {
    const status = {
      mcp: "ok",
      maps: { configured: !!MAPS_BASE_URL },
      crawl4ai: { configured: !!CRAWL4AI_BASE_URL, authConfigured: !!CRAWL4AI_API_TOKEN },
      emailEnrich: { configured: true },
      dedupe: { configured: true },
      qualification: { configured: true },
      yozh: { configured: !!YOZH_BASE_URL },
      scrapling: { configured: !!SCRAPLING_MCP_URL, authConfigured: !!SCRAPLING_MCP_TOKEN },
      keelead: { configured: !!KEELEAD_BASE_URL },
      dataforge: { configured: !!DATAFORGE_BASE_URL, authConfigured: !!DATAFORGE_API_TOKEN },
      components: {
        googleMaps: "zoeyzb/google-maps-scraper",
        crawl4ai: "unclecode/crawl4ai:latest (Railway service: crawl4ai-runtime)",
        firecrawl: "zoeyzb/firecrawl (external/optional adapter)",
        openleads: "zoeyzb/openleads",
        aura: "zoeyzb/aura-app (reference/enrichment patterns)",
        gtmSignalScoring: "zoeyzb/gtm-signal-scoring (scoring reference; full app needs DB/provider keys)",
        gtmSkills: "zoeyzb/gtm-skills (agent playbooks, not a runtime service)",
        emailEnrich: "zoeyzb/email-enrich",
        dedupe: "zoeyzb/dedupe",
        leadQualifier: "zoeyzb/LeadQualifier (offline ML reference)",
        aiLeadScoring: "zoeyzb/ai-lead-scoring-qualification (n8n reference workflow)",
        keelead: "zoeyzb/keelead (heuristic email/domain checks only; demo lead discovery and fake enrichment are intentionally disabled)",
        dataforge: "zoeyzb/dataforge (real website/email/tech enrichment API)",
        openGTM: "zoeyzb/opengtm (qualification/orchestration patterns; Gemini discovery disabled unless configured)"
      }
    };
    return jsonText(status);
  });

  server.registerTool("maps_start_job", {
    description: "Start a Google Maps business scraping job using the Gosom Google Maps scraper service.",
    inputSchema: z.object({
      keywords: z.array(z.string()).min(1),
      name: z.string().optional(),
      depth: z.number().int().min(1).max(50).default(10),
      max_time: z.number().int().min(60).max(7200).default(900),
      extra_reviews: z.boolean().default(false)
    })
  }, async ({ keywords, name, depth, max_time, extra_reviews }) => {
    if (!MAPS_BASE_URL) return { content:[{type:"text",text:"MAPS_BASE_URL is not configured"}], isError:true };
    const body = { name: name || `Recover Scrape ${new Date().toISOString()}`, keywords, depth, max_time, extra_reviews, lang: "en" };
    try {
      return jsonText(await fetchJson(`${MAPS_BASE_URL}/api/v1/jobs`, {
        method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(body)
      }, 30000));
    } catch (e) {
      return { content:[{type:"text",text:`Maps backend error: ${e.message}`}], isError:true };
    }
  });

  server.registerTool("maps_job_status", {
    description: "Get the status/details of a Google Maps scraping job.",
    inputSchema: z.object({ job_id: z.string().min(1) })
  }, async ({ job_id }) => {
    if (!MAPS_BASE_URL) return { content:[{type:"text",text:"MAPS_BASE_URL is not configured"}], isError:true };
    try { return jsonText(await fetchJson(`${MAPS_BASE_URL}/api/v1/jobs/${encodeURIComponent(job_id)}`)); }
    catch (e) { return { content:[{type:"text",text:`Maps backend error: ${e.message}`}], isError:true }; }
  });

  server.registerTool("crawl_website", {
    description: "Deep-crawl one or more public websites using Crawl4AI and return structured crawl results.",
    inputSchema: z.object({
      urls: z.array(z.string().url()).min(1).max(25),
      priority: z.number().int().min(0).max(100).default(10)
    })
  }, async ({ urls, priority }) => {
    if (!CRAWL4AI_BASE_URL) return { content:[{type:"text",text:"CRAWL4AI_BASE_URL is not configured"}], isError:true };
    const headers = {"content-type":"application/json"};
    if (CRAWL4AI_API_TOKEN) headers.authorization = `Bearer ${CRAWL4AI_API_TOKEN}`;
    try {
      return jsonText(await fetchJson(`${CRAWL4AI_BASE_URL}/crawl`, {
        method:"POST", headers, body:JSON.stringify({ urls, priority })
      }, 120000));
    } catch (e) {
      return { content:[{type:"text",text:`Crawl4AI backend error: ${e.message}`}], isError:true };
    }
  });


  server.registerTool("yozh_start_scrape", {
    description: "Start a durable browser scrape job on the internal Yozh worker queue. Use for difficult/dynamic sites when a queued Playwright worker is useful.",
    inputSchema: z.object({
      url: z.string().url(),
      proxy_type: z.enum(["none","res_rotating","res_static","mobile","mobile_shared","dc_static"]).default("none"),
      headless: z.boolean().optional(),
      browser_engine: z.enum(["chromium","camoufox"]).optional()
    })
  }, async (args) => {
    if (!YOZH_BASE_URL) return { content:[{type:"text",text:"YOZH_BASE_URL is not configured"}], isError:true };
    try {
      return jsonText(await fetchJson(`${YOZH_BASE_URL}/api/v1/scrape/page`, {
        method:"POST",
        headers:{"content-type":"application/json"},
        body:JSON.stringify(args)
      }, 30000));
    } catch (e) {
      return { content:[{type:"text",text:`Yozh backend error: ${e.message}`}], isError:true };
    }
  });

  server.registerTool("yozh_job_status", {
    description: "Check a Yozh scrape job.",
    inputSchema: z.object({ job_id: z.string().min(1) })
  }, async ({ job_id }) => {
    if (!YOZH_BASE_URL) return { content:[{type:"text",text:"YOZH_BASE_URL is not configured"}], isError:true };
    try { return jsonText(await fetchJson(`${YOZH_BASE_URL}/api/v1/scrape/${encodeURIComponent(job_id)}`)); }
    catch (e) { return { content:[{type:"text",text:`Yozh backend error: ${e.message}`}], isError:true }; }
  });

  server.registerTool("yozh_job_results", {
    description: "Fetch Yozh scrape results for a job, including partial results while still running.",
    inputSchema: z.object({ job_id: z.string().min(1) })
  }, async ({ job_id }) => {
    if (!YOZH_BASE_URL) return { content:[{type:"text",text:"YOZH_BASE_URL is not configured"}], isError:true };
    try { return jsonText(await fetchJson(`${YOZH_BASE_URL}/api/v1/scrape/${encodeURIComponent(job_id)}/results`)); }
    catch (e) { return { content:[{type:"text",text:`Yozh backend error: ${e.message}`}], isError:true }; }
  });

  server.registerTool("scrapling_stealth_fetch", {
    description: "Use Scrapling's stealth browser MCP as a fallback for difficult public websites or anti-bot protected pages.",
    inputSchema: z.object({
      url: z.string().url(),
      css_selector: z.string().optional(),
      ai_targeted: z.boolean().default(true),
      headless: z.boolean().default(true),
      network_idle: z.boolean().default(false)
    })
  }, async ({ url, css_selector, ai_targeted, headless, network_idle }) => {
    if (!SCRAPLING_MCP_URL) return { content:[{type:"text",text:"SCRAPLING_MCP_URL is not configured"}], isError:true };
    try {
      const args = { url, ai_targeted, headless, network_idle };
      if (css_selector) args.css_selector = css_selector;
      const result = await callRemoteMcpTool(SCRAPLING_MCP_URL, SCRAPLING_MCP_TOKEN, "stealthy_fetch", args);
      return jsonText(result);
    } catch (e) {
      return { content:[{type:"text",text:`Scrapling backend error: ${e.message}`}], isError:true };
    }
  });


  server.registerTool("keelead_verify_email", {
    description: "Run KeeLead heuristic checks on candidate business emails: syntax, domain, MX, disposable, role, typo, and mail-infrastructure signals. This does not prove that a specific mailbox exists or accepts mail.",
    inputSchema: z.object({
      email: z.string().email().optional(),
      emails: z.array(z.string().email()).max(100).optional()
    })
  }, async (args) => {
    if (!KEELEAD_BASE_URL) return { content:[{type:"text",text:"KEELEAD_BASE_URL is not configured"}], isError:true };
    try {
      return jsonText(await fetchJson(`${KEELEAD_BASE_URL}/api/verify`, {
        method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(args)
      }, 120000));
    } catch (e) {
      return { content:[{type:"text",text:`KeeLead verification error: ${e.message}`}], isError:true };
    }
  });

  server.registerTool("dataforge_enrich_websites", {
    description: "Enrich public business websites with real DataForge extraction: public emails, tech stack, CMS, SSL status, response speed and HTTP status.",
    inputSchema: z.object({
      urls: z.array(z.string().url()).min(1).max(100)
    })
  }, async ({ urls }) => {
    if (!DATAFORGE_BASE_URL) return { content:[{type:"text",text:"DATAFORGE_BASE_URL is not configured"}], isError:true };
    try { return jsonText({count:urls.length, results:await dataforgeScrape(urls)}); }
    catch (e) { return { content:[{type:"text",text:`DataForge error: ${e.message}`}], isError:true }; }
  });

  server.registerTool("acquire_qualified_leads", {
    description: "Start a durable background lead-acquisition job. The worker keeps discovering, deduplicating, enriching and qualifying until the target is reached or the search limit is exhausted. Use acquisition_status with the returned acquisition_id.",
    inputSchema: z.object({
      industry: z.string().min(1),
      location: z.string().min(1),
      target: z.number().int().min(1).max(5000).default(100),
      min_score: z.number().int().min(0).max(100).default(50),
      require_phone: z.boolean().default(false),
      require_email: z.boolean().default(false),
      include_no_website: z.boolean().default(true),
      max_rounds: z.number().int().min(1).max(20).default(12),
      depth: z.number().int().min(1).max(50).default(10)
    })
  }, async (args) => {
    try {
      const redis = await getAcquisitionRedis();
      const id = randomUUID();
      const job = {
        id,
        ...args,
        status:"queued",
        phase:"queued",
        round:0,
        rounds_completed:0,
        raw_count:0,
        unique_count:0,
        qualified_count:0,
        stored_count:0,
        maps_jobs:[],
        created_at:new Date().toISOString(),
        updated_at:new Date().toISOString()
      };
      await redis.set(`recover:acq:${id}`, JSON.stringify(job), { EX: 604800 });
      await redis.sAdd("recover:acq:index", id);
      await redis.lPush("recover:acquisition:queue", id);
      return jsonText({
        status:"queued",
        acquisition_id:id,
        target:args.target,
        industry:args.industry,
        location:args.location,
        next:"Call acquisition_status with acquisition_id. The background worker continues without keeping this chat request open."
      });
    } catch (e) {
      return { content:[{type:"text",text:`Acquisition queue error: ${e.message}`}], isError:true };
    }
  });

  server.registerTool("acquisition_status", {
    description: "Get live progress for a background Recover Scrape acquisition.",
    inputSchema: z.object({
      acquisition_id: z.string().min(1)
    })
  }, async ({ acquisition_id }) => {
    try {
      const redis = await getAcquisitionRedis();
      const raw = await redis.get(`recover:acq:${acquisition_id}`);
      if (!raw) {
        return { content:[{type:"text",text:"Acquisition not found or expired."}], isError:true };
      }
      const job = JSON.parse(raw);
      return jsonText({
        acquisition_id,
        status:job.status,
        phase:job.phase,
        target:job.target,
        raw_count:job.raw_count||0,
        unique_count:job.unique_count||0,
        qualified_count:job.qualified_count||0,
        stored_count:job.stored_count||0,
        rounds_completed:job.rounds_completed||0,
        max_rounds:job.max_rounds,
        current_query:job.current_query||null,
        current_maps_job_id:job.current_maps_job_id||null,
        current_maps_status:job.current_maps_status||null,
        error:job.error||null,
        reason:job.reason||null,
        created_at:job.created_at,
        updated_at:job.updated_at,
        completed_at:job.completed_at||null,
        next:["complete","partial_complete"].includes(job.status)
          ? "Call acquisition_results with acquisition_id to page the stored leads."
          : job.status==="failed"
            ? "Inspect error and start a new acquisition after fixing the backend issue."
            : "Call acquisition_status again later. The worker is still running."
      });
    } catch (e) {
      return { content:[{type:"text",text:`Acquisition status error: ${e.message}`}], isError:true };
    }
  });

  server.registerTool("acquisition_results", {
    description: "Fetch a page of persisted leads from a completed or partially completed acquisition.",
    inputSchema: z.object({
      acquisition_id: z.string().min(1),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(100)
    })
  }, async ({ acquisition_id, offset, limit }) => {
    try {
      const redis = await getAcquisitionRedis();
      const key = `recover:acq:${acquisition_id}:results`;
      const total = await redis.lLen(key);
      if (!total) {
        const raw = await redis.get(`recover:acq:${acquisition_id}`);
        if (!raw) return { content:[{type:"text",text:"Acquisition not found or expired."}], isError:true };
        const job = JSON.parse(raw);
        if (!["complete","partial_complete"].includes(job.status)) {
          return jsonText({ acquisition_id, status:job.status, total:0, leads:[], next:"The acquisition is still running. Call acquisition_status." });
        }
      }
      const rows = total ? await redis.lRange(key, offset, offset + limit - 1) : [];
      const leads = rows.map(row => { try { return JSON.parse(row); } catch { return null; } }).filter(Boolean);
      return jsonText({
        acquisition_id,
        total,
        offset,
        limit,
        returned:leads.length,
        next_offset:offset+leads.length<total ? offset+leads.length : null,
        leads
      });
    } catch (e) {
      return { content:[{type:"text",text:`Acquisition results error: ${e.message}`}], isError:true };
    }
  });

  server.registerTool("enrich_email", {
    description: "Find public professional email evidence for a named person/company using the forked email-enrich library. Use only for lawful business research/outreach.",
    inputSchema: z.object({
      person_name: z.string().min(1),
      company_name: z.string().min(1),
      company_domain: z.string().optional(),
      company_website: z.string().optional(),
      mode: z.enum(["default","strict","fast"]).default("fast"),
      real_only: z.boolean().default(true)
    })
  }, async (args) => {
    try {
      const result = await enrichEmail("recover-scrape", {
        ...args,
        company_domain: args.company_domain || "",
        company_website: args.company_website || "",
        use_case: "sales"
      });
      return jsonText(result);
    } catch (e) {
      return { content:[{type:"text",text:`Email enrichment error: ${e.message}`}], isError:true };
    }
  });

  server.registerTool("dedupe_leads", {
    description: "Deduplicate business leads using place IDs, normalized domains, normalized phones, and name+address identity.",
    inputSchema: z.object({ leads: z.array(z.record(z.string(), z.any())).max(5000) })
  }, async ({ leads }) => {
    const unique = dedupeRecords(leads);
    return jsonText({ input_count: leads.length, unique_count: unique.length, removed: leads.length - unique.length, leads: unique });
  });

  server.registerTool("qualify_leads", {
    description: "Score and rank local-service leads from 0-100 using Recover Revenue fit signals such as category, reviews, contactability and conversion gaps.",
    inputSchema: z.object({ leads: z.array(z.record(z.string(), z.any())).max(5000) })
  }, async ({ leads }) => {
    const scored = leads.map(lead => ({ ...lead, qualification: scoreLead(lead) }))
      .sort((a,b) => b.qualification.score - a.qualification.score);
    return jsonText({ count: scored.length, leads: scored });
  });

  server.registerTool("research_and_qualify", {
    description: "Orchestrate website crawling, public email enrichment when a person is known, and deterministic lead scoring for one business.",
    inputSchema: z.object({
      lead: z.record(z.string(), z.any()),
      person_name: z.string().optional()
    })
  }, async ({ lead, person_name }) => {
    const result = { lead, qualification: scoreLead(lead) };
    if (lead.website && CRAWL4AI_BASE_URL) {
      const headers = {"content-type":"application/json"};
      if (CRAWL4AI_API_TOKEN) headers.authorization = `Bearer ${CRAWL4AI_API_TOKEN}`;
      try {
        result.crawl = await fetchJson(`${CRAWL4AI_BASE_URL}/crawl`, {
          method:"POST", headers, body:JSON.stringify({ urls:[lead.website], priority:10 })
        }, 120000);
      } catch (e) { result.crawl_error = e.message; }
    }
    if (person_name && (lead.website || lead.domain)) {
      try {
        result.email = await enrichEmail("recover-scrape", {
          person_name,
          company_name: lead.name || lead.title || "",
          company_domain: lead.domain || normalizeDomain(lead.website || ""),
          company_website: lead.website || "",
          mode: "fast",
          real_only: true,
          use_case: "sales"
        });
      } catch (e) { result.email_error = e.message; }
    }
    return jsonText(result);
  });

  return server;
}

const handler = createMcpHandler(buildServer);
const nodeHandler = toNodeHandler(handler);

const httpServer = createHttpServer((req, res) => {
  if (req.url === "/health") {
    const checks = {
      maps: MAPS_BASE_URL ? `${MAPS_BASE_URL}/api/v1/jobs` : "",
      crawl4ai: CRAWL4AI_BASE_URL ? `${CRAWL4AI_BASE_URL}/health` : "",
      yozh: YOZH_BASE_URL ? `${YOZH_BASE_URL}/api/v1/health` : "",
      scrapling: SCRAPLING_MCP_URL ? SCRAPLING_MCP_URL.replace(/\/mcp$/, "/health") : "",
      keelead: KEELEAD_BASE_URL ? `${KEELEAD_BASE_URL}/api/sources` : "",
      dataforge: DATAFORGE_BASE_URL ? `${DATAFORGE_BASE_URL}/health` : ""
    };

    void (async () => {
      const backends = {};
      for (const [name, url] of Object.entries(checks)) {
        if (!url) {
          backends[name] = { configured:false, reachable:false };
          continue;
        }
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
          backends[name] = {
            configured:true,
            reachable:response.ok,
            status:response.status
          };
        } catch (error) {
          backends[name] = {
            configured:true,
            reachable:false,
            error:error?.name || "request_failed"
          };
        }
      }
      const required = ["maps","crawl4ai","yozh"];
      const ok = required.every(name => backends[name]?.reachable === true);
      res.writeHead(ok ? 200 : 503, {"content-type":"application/json"});
      res.end(JSON.stringify({ok,name:"recover-scrape-mcp",backends}));
    })();
    return;
  }
  if (req.url?.startsWith("/mcp")) {
    if (MCP_AUTH_TOKEN) {
      const auth = req.headers.authorization || "";
      if (auth !== `Bearer ${MCP_AUTH_TOKEN}`) {
        res.writeHead(401, {"content-type":"application/json"});
        res.end(JSON.stringify({error:"unauthorized"}));
        return;
      }
    }
    void nodeHandler(req, res);
    return;
  }
  res.writeHead(404, {"content-type":"application/json"});
  res.end(JSON.stringify({error:"not_found",mcp:"/mcp",health:"/health"}));
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Recover Scrape MCP listening on 0.0.0.0:${PORT}`);
});
