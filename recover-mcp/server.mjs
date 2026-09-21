import { createServer as createHttpServer } from "node:http";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createClient } from "redis";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod/v4";
import { orchestrate as enrichEmail } from "email-enrich";
import { campaignLeadSetKey } from "./acquisition-coverage.mjs";
import { isCoreHomeServiceLead } from "./home-service-targeting.mjs";
import { startQualifiedGoogleSheetSync } from "./google-sheet-direct-sync.mjs";
import { createSmsSheetBridge } from "./sms-sheet-bridge.mjs";
import {
  bulkSmsBlockReason,
  bulkSmsOverrideStopReason,
  isCarrierRegistrationError,
  reachabilityForLookupDecision,
  shouldPostSmsResultCallback,
  shouldResumePausedSmsBatch,
  smsDeliveryStatusBucket,
} from "./sms-delivery-guard.mjs";
// Lead-sheet template rows 1-6 are reserved for title, KPIs, and headers.

const PORT = Number(process.env.PORT || 3000);
const MAPS_BASE_URL = (process.env.MAPS_BASE_URL || "").replace(/\/$/, "");
const CRAWL4AI_BASE_URL = (process.env.CRAWL4AI_BASE_URL || "").replace(/\/$/, "");
const CRAWL4AI_API_TOKEN = process.env.CRAWL4AI_API_TOKEN || "";
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";
const MCP_AUTH_TOKEN_SECONDARY = process.env.MCP_AUTH_TOKEN_SECONDARY || "";
const OAUTH_ISSUER = (process.env.OAUTH_ISSUER || "").replace(/\/$/, "");
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID || "";
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET || "";
const OAUTH_SIGNING_SECRET = process.env.OAUTH_SIGNING_SECRET || "";
const OAUTH_ACCESS_KEY = process.env.OAUTH_ACCESS_KEY || "";
const YOZH_BASE_URL = (process.env.YOZH_BASE_URL || "").replace(/\/$/, "");
const SCRAPLING_MCP_URL = (process.env.SCRAPLING_MCP_URL || "").replace(/\/$/, "");
const SCRAPLING_MCP_TOKEN = process.env.SCRAPLING_MCP_TOKEN || "";
const KEELEAD_BASE_URL = (process.env.KEELEAD_BASE_URL || "").replace(/\/$/, "");
const DATAFORGE_BASE_URL = (process.env.DATAFORGE_BASE_URL || "").replace(/\/$/, "");
const DATAFORGE_API_TOKEN = process.env.DATAFORGE_API_TOKEN || "";
const ACQUISITION_REDIS_URL = process.env.ACQUISITION_REDIS_URL || "";
const TELNYX_API_KEY = process.env.TELNYX_API_KEY || "";
const TELNYX_FROM_NUMBER = process.env.TELNYX_FROM_NUMBER || "";
const TELNYX_WEBHOOK_URL = (process.env.TELNYX_WEBHOOK_URL || "").trim();
const INBOX_ACCESS_PASSWORD = String(process.env.INBOX_ACCESS_PASSWORD || "");
const TELNYX_AUTO_CONFIGURE_PROFILE = String(process.env.TELNYX_AUTO_CONFIGURE_PROFILE || "").toLowerCase() === "true";
const RAILWAY_PUBLIC_DOMAIN = String(process.env.RAILWAY_PUBLIC_DOMAIN || "").trim();
const SMS_SEND_INTERVAL_MS = Math.max(100, Number(process.env.SMS_SEND_INTERVAL_MS || 30000));
const SMS_MAX_BATCH_RECIPIENTS = Math.max(1, Number(process.env.SMS_MAX_BATCH_RECIPIENTS || 5000));
const SMS_BULK_CAMPAIGN_ID = String(process.env.SMS_BULK_CAMPAIGN_ID || "").trim();
const SMS_BULK_SPREADSHEET_ID = String(process.env.SMS_BULK_SPREADSHEET_ID || "").trim();
const SMS_BULK_TAB_NAME = String(process.env.SMS_BULK_TAB_NAME || "").trim();
const SMS_BULK_START_ROW = Math.max(1, Number(process.env.SMS_BULK_START_ROW || 0));
const SMS_BULK_END_ROW = Math.max(1, Number(process.env.SMS_BULK_END_ROW || 0));
const SMS_BULK_USER_CONFIRMED_CONSENT = String(process.env.SMS_BULK_USER_CONFIRMED_CONSENT || "").toLowerCase() === "true";
const SMS_BULK_AUTOSTART = String(process.env.SMS_BULK_AUTOSTART || "").toLowerCase() === "true";
const SMS_BULK_PAUSED = String(process.env.SMS_BULK_PAUSED || "").toLowerCase() === "true";
// Sending is fail-closed until carrier registration is explicitly confirmed.
const SMS_10DLC_APPROVED = String(process.env.SMS_10DLC_APPROVED || "").toLowerCase() === "true";
const SMS_UNREGISTERED_SEND_OVERRIDE = String(process.env.SMS_UNREGISTERED_SEND_OVERRIDE || "").toLowerCase() === "true";
const SMS_OVERRIDE_FAILURE_CUTOFF_PERCENT = Math.min(100, Math.max(1, Number(process.env.SMS_OVERRIDE_FAILURE_CUTOFF_PERCENT || 70)));
const RECOVER_REVENUE_SMS_CALLBACK_URL = (process.env.RECOVER_REVENUE_SMS_CALLBACK_URL || "").replace(/\/$/, "");
const RECOVER_REVENUE_SMS_CALLBACK_SECRET = process.env.RECOVER_REVENUE_SMS_CALLBACK_SECRET || "";
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
const GOOGLE_SHEETS_TARGETS_JSON = process.env.GOOGLE_SHEETS_TARGETS_JSON || "";
const GOOGLE_SHEETS_SYNC_ENABLED = String(process.env.GOOGLE_SHEETS_SYNC_ENABLED || "").toLowerCase() === "true";
const GOOGLE_SHEETS_SYNC_INTERVAL_MS = Math.max(30000, Number(process.env.GOOGLE_SHEETS_SYNC_INTERVAL_MS || 60000));
const GOOGLE_SHEETS_TAB_CAPACITY = Math.max(1, Number(process.env.GOOGLE_SHEETS_TAB_CAPACITY || 50000));
const SMS_SHEET_BRIDGE = createSmsSheetBridge({ serviceAccountJson: GOOGLE_SERVICE_ACCOUNT_JSON, targetsJson: GOOGLE_SHEETS_TARGETS_JSON });
if (SMS_SHEET_BRIDGE.writer_email) {
  console.log("SMS sheet writer email", SMS_SHEET_BRIDGE.writer_email);
}
let acquisitionRedisPromise = null;
const INBOX_SSE_CLIENTS = new Set();

function broadcastInboxEvent(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of [...INBOX_SSE_CLIENTS]) {
    try { res.write(payload); } catch { INBOX_SSE_CLIENTS.delete(res); }
  }
}


const oauthEnabled = Boolean(OAUTH_ISSUER && OAUTH_CLIENT_ID && OAUTH_CLIENT_SECRET && OAUTH_SIGNING_SECRET && OAUTH_ACCESS_KEY);

function secureEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function signOauthToken(payload) {
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", OAUTH_SIGNING_SECRET).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyOauthToken(token, expectedType) {
  if (!oauthEnabled || typeof token !== "string") return null;
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) return null;
  const expected = createHmac("sha256", OAUTH_SIGNING_SECRET).update(encoded).digest("base64url");
  if (!secureEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (payload.typ !== expectedType || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}

function oauthMetadata() {
  return {
    issuer: OAUTH_ISSUER,
    authorization_endpoint: `${OAUTH_ISSUER}/oauth/authorize`,
    token_endpoint: `${OAUTH_ISSUER}/oauth/token`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    scopes_supported: ["recover_scrape"]
  };
}

function protectedResourceMetadata() {
  return { resource:`${OAUTH_ISSUER}/mcp`, authorization_servers:[OAUTH_ISSUER], scopes_supported:["recover_scrape"], bearer_methods_supported:["header"] };
}

function validChatGptRedirect(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["chatgpt.com", "www.chatgpt.com"].includes(url.hostname);
  } catch { return false; }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]);
}

async function readForm(req, maxBytes = 16384) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function oauthError(res, status, error, description) {
  res.writeHead(status, {"content-type":"application/json", "cache-control":"no-store"});
  res.end(JSON.stringify({error, error_description:description}));
}

function validateOauthClient(req, form) {
  let clientId = form.get("client_id") || "";
  let clientSecret = form.get("client_secret") || "";
  const authorization = req.headers.authorization || "";
  if (authorization.startsWith("Basic ")) {
    try {
      const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      clientId = decodeURIComponent(decoded.slice(0, separator));
      clientSecret = decodeURIComponent(decoded.slice(separator + 1));
    } catch {}
  }
  return secureEqual(clientId, OAUTH_CLIENT_ID) && secureEqual(clientSecret, OAUTH_CLIENT_SECRET);
}

function issueOauthTokens(scope = "recover_scrape") {
  const now = Math.floor(Date.now() / 1000);
  return {
    access_token:signOauthToken({typ:"access",scope,iat:now,exp:now+3600}), token_type:"Bearer", expires_in:3600,
    refresh_token:signOauthToken({typ:"refresh",scope,iat:now,exp:now+2592000}), scope
  };
}

async function handleOauthAuthorize(req, res, url) {
  const params = req.method === "POST" ? await readForm(req) : url.searchParams;
  const clientId = params.get("client_id") || "";
  const redirectUri = params.get("redirect_uri") || "";
  const state = params.get("state") || "";
  const codeChallenge = params.get("code_challenge") || "";
  if (!secureEqual(clientId, OAUTH_CLIENT_ID) || !validChatGptRedirect(redirectUri) || !state || !codeChallenge || params.get("code_challenge_method") !== "S256") {
    return oauthError(res, 400, "invalid_request", "Invalid OAuth client, callback, state, or PKCE parameters.");
  }
  if (req.method === "GET") {
    const hidden = [...params.entries()].map(([key,value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`).join("");
    res.writeHead(200, {"content-type":"text/html; charset=utf-8", "cache-control":"no-store", "x-frame-options":"DENY"});
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Authorize Recover Scrape</title></head><body style="font-family:system-ui;max-width:440px;margin:48px auto;padding:20px"><h1>Authorize Recover Scrape</h1><p>Enter the private Recover Scrape access key to connect ChatGPT.</p><form method="post">${hidden}<label>Access key<br><input name="access_key" type="password" required autocomplete="current-password" style="width:100%;padding:10px;margin:8px 0 16px"></label><button type="submit" style="padding:10px 16px">Authorize</button></form></body></html>`);
    return;
  }
  if (!secureEqual(params.get("access_key") || "", OAUTH_ACCESS_KEY)) return oauthError(res, 403, "access_denied", "The Recover Scrape access key is invalid.");
  const now = Math.floor(Date.now()/1000);
  const code = signOauthToken({typ:"code",client_id:clientId,redirect_uri:redirectUri,code_challenge:codeChallenge,scope:"recover_scrape",iat:now,exp:now+300});
  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", code);
  redirect.searchParams.set("state", state);
  res.writeHead(302, {location:redirect.toString(), "cache-control":"no-store"}); res.end();
}

async function handleOauthToken(req, res) {
  const form = await readForm(req);
  if (!validateOauthClient(req, form)) return oauthError(res, 401, "invalid_client", "Client authentication failed.");
  if (form.get("grant_type") === "authorization_code") {
    const payload = verifyOauthToken(form.get("code"), "code");
    const challenge = createHash("sha256").update(form.get("code_verifier") || "").digest("base64url");
    if (!payload || !secureEqual(payload.client_id,OAUTH_CLIENT_ID) || !secureEqual(payload.redirect_uri,form.get("redirect_uri")||"") || !secureEqual(payload.code_challenge,challenge)) return oauthError(res,400,"invalid_grant","Authorization code or PKCE verification failed.");
    res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"}); res.end(JSON.stringify(issueOauthTokens(payload.scope))); return;
  }
  if (form.get("grant_type") === "refresh_token") {
    const payload = verifyOauthToken(form.get("refresh_token"), "refresh");
    if (!payload) return oauthError(res,400,"invalid_grant","Refresh token is invalid or expired.");
    res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"}); res.end(JSON.stringify(issueOauthTokens(payload.scope))); return;
  }
  oauthError(res,400,"unsupported_grant_type","Use authorization_code or refresh_token.");
}

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

async function getQualifiedSheetLeads(redis) {
  const values = await redis.hVals("recover:leadstore:qualified");
  return values
    .map((value) => { try { return value ? JSON.parse(value) : null; } catch { return null; } })
    .filter(Boolean)
    .filter((lead) => {
      const noWebsite = !String(lead.website || "").trim();
      const emails = Array.isArray(lead.emails)
        ? lead.emails
        : String(lead.email || lead.emails || "").split(/[;,\s]+/).filter(Boolean);
      const contactable = !!String(lead.phone || "").trim() || emails.length > 0;
      return noWebsite && contactable && isCoreHomeServiceLead(lead);
    });
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
    city: lead.city || lead.locality || "",
    region: lead.region || lead.state || lead.state_code || "",
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


function normalizeE164(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (raw.startsWith("+") && digits.length >= 8 && digits.length <= 15) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return "";
}

function gsm7Safe(value = "") {
  return String(value || "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x0A\x0D\x20-\x7E]/g, "");
}

function compactBulkSms(originalText = "", metadata = {}) {
  const link = gsm7Safe(String(metadata?.link || "").trim());
  const business = gsm7Safe(String(metadata?.business_name || "").trim());
  const original = gsm7Safe(originalText).trim();

  if (!link || !/^https:\/\//i.test(link)) return original;

  const prefix = link + "\n";
  const candidates = [
    business ? `Made this for ${business}. Thoughts? - Sierra` : "",
    "Made this for your business. Thoughts? - Sierra",
    "Made this for you. Thoughts? - Sierra",
    "Made this for you. - Sierra",
    "- Sierra",
    ""
  ].filter((x, i, arr) => i === arr.indexOf(x));

  for (const body of candidates) {
    const text = body ? prefix + body : link;
    if (smsSegmentEstimate(text) <= 1 && text.length <= 160) return text;
  }

  return link;
}

function smsSegmentEstimate(text = "") {
  const value = String(text || "");
  const ascii = /^[\x00-\x7F]*$/.test(value);
  const single = ascii ? 160 : 70;
  const concat = ascii ? 153 : 67;
  if (value.length <= single) return 1;
  return Math.ceil(value.length / concat);
}

async function prepareSmsBatch({ recipients, label }) {
  const redis = await getAcquisitionRedis();
  const suppressed = [];
  const invalid = [];
  const seen = new Set();
  const accepted = [];
  let estimatedSegments = 0;

  if (recipients.length > SMS_MAX_BATCH_RECIPIENTS) {
    throw new Error(`Batch exceeds SMS_MAX_BATCH_RECIPIENTS (${SMS_MAX_BATCH_RECIPIENTS})`);
  }
  for (let i = 0; i < recipients.length; i++) {
    const row = recipients[i] || {};
    const phone = normalizeE164(row.phone);
    if (!phone) { invalid.push({ index:i, reason:"invalid_phone" }); continue; }
    if (row.consent !== true) { invalid.push({ index:i, phone, reason:"consent_not_confirmed" }); continue; }
    if (seen.has(phone)) { invalid.push({ index:i, phone, reason:"duplicate_phone" }); continue; }
    seen.add(phone);

    const isSuppressed = await redis.sIsMember("recover:sms:suppressed", phone);
    if (isSuppressed) { suppressed.push({ index:i, phone, reason:"suppressed" }); continue; }

    const messages = Array.isArray(row.messages)
      ? row.messages.map(x => String(x || "").trim()).filter(Boolean).slice(0, 3)
      : [String(row.message || "").trim()].filter(Boolean);
    if (!messages.length) { invalid.push({ index:i, phone, reason:"missing_message" }); continue; }
    if (messages.some(m => m.length > 1600)) { invalid.push({ index:i, phone, reason:"message_too_long" }); continue; }

    const segments = messages.reduce((sum, msg) => sum + smsSegmentEstimate(msg), 0);
    estimatedSegments += segments;
    accepted.push({
      phone,
      messages,
      contact_id: String(row.contact_id || row.id || ""),
      metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : {},
      estimated_segments: segments
    });
  }

  const batchId = randomUUID();
  const confirmationToken = randomUUID();
  const payload = {
    id: batchId,
    label: String(label || ""),
    status: "prepared",
    accepted_count: accepted.length,
    estimated_segments: estimatedSegments,
    recipients: accepted,
    invalid,
    suppressed,
    created_at: new Date().toISOString()
  };
  await redis.set(`recover:sms:batch:${batchId}`, JSON.stringify(payload), { EX: 3600 });
  await redis.set(`recover:sms:confirm:${batchId}`, confirmationToken, { EX: 3600 });
  return { ...payload, recipients: accepted.slice(0, 10), confirmation_token: confirmationToken };
}

async function enqueuePreparedSmsBatch(batchId, confirmationToken) {
  const redis = await getAcquisitionRedis();
  const raw = await redis.get(`recover:sms:batch:${batchId}`);
  if (!raw) throw new Error("Prepared SMS batch not found or expired");
  const expected = await redis.get(`recover:sms:confirm:${batchId}`);
  if (!expected || !secureEqual(expected, confirmationToken || "")) throw new Error("Confirmation token is invalid or expired");
  const batch = JSON.parse(raw);
  if (batch.status !== "prepared") throw new Error(`Batch is already ${batch.status}`);
  batch.status = "queued";
  batch.queued_at = new Date().toISOString();
  await redis.set(`recover:sms:batch:${batchId}`, JSON.stringify(batch), { EX: 604800 });
  await redis.del(`recover:sms:confirm:${batchId}`);
  await redis.lPush("recover:sms:queue", batchId);
  return batch;
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
      require_contact: z.boolean().default(false),
      require_no_website: z.boolean().default(false),
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
    description: "Fetch a page of already-persisted acquisition leads, including while the acquisition is still running.",
    inputSchema: z.object({
      acquisition_id: z.string().min(1),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(100)
    })
  }, async ({ acquisition_id, offset, limit }) => {
    try {
      const redis = await getAcquisitionRedis();
      const key = `recover:acq:${acquisition_id}:results`;
      const raw = await redis.get(`recover:acq:${acquisition_id}`);
      if (!raw) return { content:[{type:"text",text:"Acquisition not found or expired."}], isError:true };
      const job = JSON.parse(raw);
      const total = await redis.lLen(key);
      const rows = total ? await redis.lRange(key, offset, offset + limit - 1) : [];
      const leads = rows.map(row => { try { return JSON.parse(row); } catch { return null; } }).filter(Boolean);
      return jsonText({
        acquisition_id,
        status:job.status,
        stored_count:job.stored_count||total,
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


  server.registerTool("sms_telnyx_account_inventory", {
    description: "Read the Telnyx account phone numbers and messaging profiles using the configured Railway API key. Read only; never exposes the API key."
  }, async () => {
    try {
      const inventory = await telnyxAccountInventory();
      return jsonText({
        authenticated: true,
        webhook_target: TELNYX_WEBHOOK_URL || null,
        ...inventory
      });
    } catch (e) {
      return { content:[{type:"text",text:`Telnyx inventory error: ${e.message}`}], isError:true };
    }
  });

  server.registerTool("sms_telnyx_configure_profile", {
    description: "Create or update the Recover Telnyx Messaging Profile with the Recover inbound/delivery webhook. Requires explicit confirm=true because it changes Telnyx account configuration.",
    inputSchema: z.object({
      profile_id: z.string().optional(),
      name: z.string().min(1).max(128).default("Recover Revenue"),
      confirm: z.literal(true)
    })
  }, async ({ profile_id, name }) => {
    try {
      return jsonText(await configureTelnyxMessagingProfile({ profileId: profile_id || "", name }));
    } catch (e) {
      return { content:[{type:"text",text:`Telnyx profile configuration error: ${e.message}`}], isError:true };
    }
  });

  server.registerTool("sms_telnyx_assign_number", {
    description: "Assign an existing Telnyx phone number to a Messaging Profile. Requires explicit confirm=true. Does not purchase a number.",
    inputSchema: z.object({
      phone_number_id: z.string().min(1),
      messaging_profile_id: z.string().uuid(),
      confirm: z.literal(true)
    })
  }, async ({ phone_number_id, messaging_profile_id }) => {
    try {
      return jsonText(await assignTelnyxNumberToProfile({ phoneNumberId: phone_number_id, messagingProfileId: messaging_profile_id }));
    } catch (e) {
      return { content:[{type:"text",text:`Telnyx number assignment error: ${e.message}`}], isError:true };
    }
  });

  server.registerTool("sms_telnyx_status", {
    description: "Check whether Recover Scrape is configured for consent-based Telnyx SMS sending. Does not expose secrets."
  }, async () => {
    return jsonText({
      telnyx_api_key_configured: !!TELNYX_API_KEY,
      from_number_configured: !!TELNYX_FROM_NUMBER,
      redis_configured: !!ACQUISITION_REDIS_URL,
      result_callback_configured: !!(RECOVER_REVENUE_SMS_CALLBACK_URL && RECOVER_REVENUE_SMS_CALLBACK_SECRET),
      ready_to_prepare: !!ACQUISITION_REDIS_URL,
      ready_to_send: !!(TELNYX_API_KEY && TELNYX_FROM_NUMBER && ACQUISITION_REDIS_URL),
      send_interval_ms: SMS_SEND_INTERVAL_MS,
      max_batch_recipients: SMS_MAX_BATCH_RECIPIENTS
    });
  });

  server.registerTool("sms_sheet_status", {
    description: "Check the configured Recover Google Sheets SMS workflow and the exact columns used. Read only."
  }, async () => {
    return jsonText({
      configured: SMS_SHEET_BRIDGE.configured,
      target_count: SMS_SHEET_BRIDGE.target_count,
      targets: SMS_SHEET_BRIDGE.targets,
      schema: SMS_SHEET_BRIDGE.schema
    });
  });

  server.registerTool("sms_prepare_sheet_range", {
    description: "Prepare a consent-based Telnyx batch from personalized messages entered in Recover lead-sheet rows. Reads phone from column I, message from Z, consent from AA, and requires READY/PREPARE in AB. This never sends. Maximum 5000 rows.",
    inputSchema: z.object({
      spreadsheet_id: z.string().min(10),
      tab_name: z.string().min(1),
      start_row: z.number().int().min(7),
      end_row: z.number().int().min(7)
    })
  }, async ({ spreadsheet_id, tab_name, start_row, end_row }) => {
    try {
      if (!SMS_SHEET_BRIDGE.configured) throw new Error("SMS sheet bridge is not configured");
      if (end_row < start_row) throw new Error("end_row must be >= start_row");
      if (end_row - start_row + 1 > 5000) throw new Error("Maximum sheet preparation range is 5000 rows");

      const rows = await SMS_SHEET_BRIDGE.readRows({
        spreadsheetId: spreadsheet_id,
        tabName: tab_name,
        startRow: start_row,
        endRow: end_row
      });
      const ready = rows.filter((row) => row.ready);
      if (!ready.length) throw new Error("No rows are marked READY/PREPARE in this range");

      const recipients = ready.map((row) => ({
        phone: row.phone,
        message: row.message,
        consent: row.consent,
        contact_id: row.lead_id,
        metadata: {
          sheet_spreadsheet_id: spreadsheet_id,
          sheet_tab_name: tab_name,
          sheet_row: row.row,
          business_name: row.business_name,
          lead_id: row.lead_id
        }
      }));
      const preview = await prepareSmsBatch({
        recipients,
        label: `Sheet ${tab_name} rows ${start_row}-${end_row}`
      });

      const invalidByIndex = new Map((preview.invalid || []).map((row) => [row.index, row.reason]));
      const suppressedByIndex = new Map((preview.suppressed || []).map((row) => [row.index, row.reason]));
      const updates = ready.map((row, index) => {
        const reason = invalidByIndex.get(index) || suppressedByIndex.get(index) || "";
        const accepted = !reason;
        return {
          row: row.row,
          status: accepted ? "Prepared" : `Blocked - ${reason || "Not accepted"}`,
          batch_id: accepted ? preview.id : "",
          updated_at: new Date().toISOString(),
          error: reason
        };
      });
      await SMS_SHEET_BRIDGE.writeRows({
        spreadsheetId: spreadsheet_id,
        tabName: tab_name,
        updates
      });

      return jsonText({
        spreadsheet_id,
        tab_name,
        requested_rows: ready.length,
        batch_id: preview.id,
        status: preview.status,
        accepted_count: preview.accepted_count,
        invalid_count: preview.invalid.length,
        suppressed_count: preview.suppressed.length,
        estimated_segments: preview.estimated_segments,
        sample: preview.recipients,
        invalid: preview.invalid.slice(0, 25),
        suppressed: preview.suppressed.slice(0, 25),
        confirmation_token: preview.confirmation_token,
        expires_in_seconds: 3600,
        next: "Show this preview to the user. Only after explicit confirmation of this exact batch, call sms_send_prepared_batch."
      });
    } catch (e) {
      return { content:[{type:"text",text:`SMS sheet prepare error: ${e.message}`}], isError:true };
    }
  });

  server.registerTool("sms_prepare_batch", {
    description: "Prepare and validate a consent-based SMS batch without sending it. Every recipient must have consent=true. Deduplicates phones, excludes STOP/suppressed numbers, estimates SMS segments, and returns a one-time confirmation token. Use this before sms_send_prepared_batch.",
    inputSchema: z.object({
      label: z.string().max(120).optional(),
      recipients: z.array(z.object({
        phone: z.string().min(3),
        message: z.string().max(1600).optional(),
        messages: z.array(z.string().max(1600)).min(1).max(3).optional(),
        consent: z.literal(true),
        contact_id: z.string().optional(),
        id: z.string().optional(),
        metadata: z.record(z.string(), z.any()).optional()
      })).min(1).max(5000)
    })
  }, async ({ recipients, label }) => {
    try {
      const preview = await prepareSmsBatch({ recipients, label });
      return jsonText({
        batch_id: preview.id,
        status: preview.status,
        label: preview.label,
        accepted_count: preview.accepted_count,
        invalid_count: preview.invalid.length,
        suppressed_count: preview.suppressed.length,
        estimated_segments: preview.estimated_segments,
        sample: preview.recipients,
        invalid: preview.invalid.slice(0, 25),
        suppressed: preview.suppressed.slice(0, 25),
        confirmation_token: preview.confirmation_token,
        expires_in_seconds: 3600,
        next: "Only after the user explicitly confirms this exact prepared batch, call sms_send_prepared_batch with batch_id and confirmation_token."
      });
    } catch (e) {
      return { content:[{type:"text",text:`SMS prepare error: ${e.message}`}], isError:true };
    }
  });

  server.registerTool("sms_send_prepared_batch", {
    description: "Queue a previously prepared SMS batch for sending. Call only after the user explicitly confirms the exact prepared batch and recipient count. Requires the one-time confirmation token returned by sms_prepare_batch.",
    inputSchema: z.object({
      batch_id: z.string().uuid(),
      confirmation_token: z.string().uuid()
    })
  }, async ({ batch_id, confirmation_token }) => {
    try {
      if (!TELNYX_API_KEY) throw new Error("TELNYX_API_KEY is not configured");
      if (!TELNYX_FROM_NUMBER) throw new Error("TELNYX_FROM_NUMBER is not configured");
      const batch = await enqueuePreparedSmsBatch(batch_id, confirmation_token);
      await SMS_SHEET_BRIDGE.markBatchQueued(batch).catch(error => console.error("SMS sheet queued writeback error", error.message));
      return jsonText({
        batch_id,
        status: batch.status,
        accepted_count: batch.accepted_count,
        estimated_segments: batch.estimated_segments,
        queued_at: batch.queued_at,
        next: "Use sms_batch_status to monitor progress."
      });
    } catch (e) {
      return { content:[{type:"text",text:`SMS queue error: ${e.message}`}], isError:true };
    }
  });

  server.registerTool("sms_batch_status", {
    description: "Check a prepared, queued, running, completed, or failed SMS batch.",
    inputSchema: z.object({ batch_id: z.string().uuid() })
  }, async ({ batch_id }) => {
    try {
      const redis = await getAcquisitionRedis();
      const raw = await redis.get(`recover:sms:batch:${batch_id}`);
      if (!raw) return { content:[{type:"text",text:"SMS batch not found or expired."}], isError:true };
      const batch = JSON.parse(raw);
      return jsonText({
        batch_id,
        label: batch.label || "",
        status: batch.status,
        accepted_count: batch.accepted_count || 0,
        estimated_segments: batch.estimated_segments || 0,
        sent_count: batch.sent_count || 0,
        failed_count: batch.failed_count || 0,
        processed_count: batch.processed_count || 0,
        created_at: batch.created_at,
        queued_at: batch.queued_at || null,
        started_at: batch.started_at || null,
        completed_at: batch.completed_at || null,
        error: batch.error || null
      });
    } catch (e) {
      return { content:[{type:"text",text:`SMS status error: ${e.message}`}], isError:true };
    }
  });

  server.registerTool("sms_batch_results", {
    description: "Get delivery-request results recorded by the SMS worker for a batch. This reflects Telnyx API acceptance/failure, not final carrier delivery receipts.",
    inputSchema: z.object({
      batch_id: z.string().uuid(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(200).default(100)
    })
  }, async ({ batch_id, offset, limit }) => {
    try {
      const redis = await getAcquisitionRedis();
      const key = `recover:sms:batch:${batch_id}:results`;
      const total = await redis.lLen(key);
      const rows = total ? await redis.lRange(key, offset, offset + limit - 1) : [];
      const results = rows.map(x => { try { return JSON.parse(x); } catch { return { raw:x }; } });
      return jsonText({
        batch_id,
        total,
        offset,
        returned: results.length,
        next_offset: offset + results.length < total ? offset + results.length : null,
        results
      });
    } catch (e) {
      return { content:[{type:"text",text:`SMS results error: ${e.message}`}], isError:true };
    }
  });

  server.registerTool("sms_suppress_number", {
    description: "Add a phone number to the permanent SMS suppression set, for example after STOP/opt-out.",
    inputSchema: z.object({ phone: z.string().min(3), reason: z.string().max(120).default("manual_opt_out") })
  }, async ({ phone, reason }) => {
    try {
      const normalized = normalizeE164(phone);
      if (!normalized) throw new Error("Invalid phone number");
      const redis = await getAcquisitionRedis();
      await redis.sAdd("recover:sms:suppressed", normalized);
      await redis.hSet("recover:sms:suppression:reasons", normalized, JSON.stringify({reason,at:new Date().toISOString()}));
      return jsonText({ phone: normalized, suppressed: true, reason });
    } catch (e) {
      return { content:[{type:"text",text:`SMS suppression error: ${e.message}`}], isError:true };
    }
  });

  return server;
}



async function postSmsResultCallback(payload) {
  if (!RECOVER_REVENUE_SMS_CALLBACK_URL || !RECOVER_REVENUE_SMS_CALLBACK_SECRET) return { configured:false };
  const response = await fetch(RECOVER_REVENUE_SMS_CALLBACK_URL, {
    method:"POST",
    headers:{
      authorization:`Bearer ${RECOVER_REVENUE_SMS_CALLBACK_SECRET}`,
      "content-type":"application/json"
    },
    body:JSON.stringify(payload),
    signal:AbortSignal.timeout(10000)
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Recover Revenue SMS callback ${response.status}: ${raw.slice(0,500)}`);
  return { configured:true, ok:true };
}


function inboxSessionToken() {
  if (!INBOX_ACCESS_PASSWORD || !MCP_AUTH_TOKEN) return "";
  return createHmac("sha256", MCP_AUTH_TOKEN).update("recover-inbox:" + INBOX_ACCESS_PASSWORD).digest("base64url");
}

function inboxWebhookToken() {
  if (!MCP_AUTH_TOKEN) return "";
  return createHmac("sha256", MCP_AUTH_TOKEN).update("recover-telnyx-webhook").digest("hex");
}

function inboxCookie(req) {
  const source = String(req.headers.cookie || "");
  for (const part of source.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === "recover_inbox") return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return "";
}

function inboxAuthorized(req) {
  const expected = inboxSessionToken();
  return Boolean(expected) && secureEqual(inboxCookie(req), expected);
}

async function readRawBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function normalizeInboxPhone(value = "") {
  const text = String(value || "").trim();
  const digits = text.replace(/\D/g, "");
  if (!digits) return "";
  return "+" + digits;
}

async function saveInboxMessage({ id, phone, direction, text, status = "", at = "", raw = null }) {
  const redis = await getAcquisitionRedis();
  const normalized = normalizeInboxPhone(phone);
  if (!normalized) return null;
  const messageId = String(id || randomUUID());
  const occurredAt = at || new Date().toISOString();
  const score = Math.max(0, Date.parse(occurredAt) || Date.now());
  const key = "recover:sms:inbox:messages";
  let prior = null;
  try {
    const rawPrior = await redis.hGet(key, messageId);
    prior = rawPrior ? JSON.parse(rawPrior) : null;
  } catch {}
  const value = {
    id: messageId,
    phone: normalized,
    direction: direction === "inbound" ? "inbound" : "outbound",
    text: String(prior?.text || text || ""),
    status: String(status || prior?.status || ""),
    at: occurredAt,
    raw: raw || prior?.raw || null
  };
  await redis.hSet(key, messageId, JSON.stringify(value));
  await redis.zAdd(`recover:sms:inbox:thread:${normalized}`, [{ score, value: messageId }]);
  await redis.zAdd("recover:sms:inbox:threads", [{ score, value: normalized }]);
  if (value.direction === "inbound") {
    await redis.zAdd("recover:sms:inbox:reply-threads", [{ score, value: normalized }]);
  }
  broadcastInboxEvent({ type:"message", phone:normalized, direction:value.direction, status:value.status, at:value.at, id:value.id });
  return value;
}

async function updateInboxMessageStatus(messageId, status, raw = null) {
  const redis = await getAcquisitionRedis();
  const key = "recover:sms:inbox:messages";
  const existingRaw = await redis.hGet(key, String(messageId || ""));
  if (!existingRaw) return null;
  const existing = JSON.parse(existingRaw);
  const next = { ...existing, status: String(status || existing.status || ""), raw: raw || existing.raw || null };
  await redis.hSet(key, String(messageId), JSON.stringify(next));
  broadcastInboxEvent({ type:"status", phone:next.phone, direction:next.direction, status:next.status, at:next.at, id:next.id });
  return next;
}

async function logInboxDeliveryFailureDiagnostics({ limit = 50 } = {}) {
  const redis = await getAcquisitionRedis();
  const all = await redis.hGetAll("recover:sms:inbox:messages");
  let failures = 0;
  for (const [id, raw] of Object.entries(all || {})) {
    if (failures >= limit) break;
    let msg;
    try { msg = JSON.parse(raw); } catch { continue; }
    const status = String(msg?.status || "").toLowerCase();
    if (!/(fail|reject|undeliver|expired|blocked)/.test(status)) continue;
    const payload = msg?.raw?.data?.payload || msg?.raw?.payload || msg?.raw || {};
    const to = Array.isArray(payload?.to) ? payload.to[0] || {} : {};
    const errors = Array.isArray(payload?.errors) ? payload.errors : [];
    const profileRaw = await redis.get(`recover:sms:inbox:contact:${msg.phone}`).catch(() => null);
    let profile = null;
    try { profile = profileRaw ? JSON.parse(profileRaw) : null; } catch {}
    console.log("SMS delivery failure diagnostic", {
      messageId: id,
      sheetRow: profile?.sheet_row || null,
      businessName: profile?.business_name || null,
      phoneHint: msg?.phone ? `••••${String(msg.phone).slice(-4)}` : null,
      status: msg?.status || null,
      toStatus: to?.status || null,
      errors: errors.map(e => ({
        code: e?.code || null,
        title: e?.title || null,
        detail: e?.detail || null
      })),
      textStartsWithHttps: /^https:\/\//i.test(String(msg?.text || "").trim())
    });
    failures++;
  }
  return { failures_logged: failures };
}

async function saveInboxContactProfile(phone, metadata = {}) {
  const redis = await getAcquisitionRedis();
  const normalized = normalizeInboxPhone(phone);
  if (!normalized) return null;
  const profile = {
    phone: normalized,
    business_name: String(metadata?.business_name || "").trim() || null,
    campaign_id: String(metadata?.campaign_id || "").trim() || null,
    sheet_row: metadata?.sheet_row ?? null,
    sheet_spreadsheet_id: String(metadata?.sheet_spreadsheet_id || "").trim() || null,
    sheet_tab_name: String(metadata?.sheet_tab_name || "").trim() || null,
    link: String(metadata?.link || "").trim() || null,
    updated_at: new Date().toISOString()
  };
  await redis.set(`recover:sms:inbox:contact:${normalized}`, JSON.stringify(profile), { EX: 2592000 });
  return profile;
}

async function inboxFailureBreakdown() {
  const redis = await getAcquisitionRedis();
  const all = await redis.hVals("recover:sms:inbox:messages");
  let outbound = 0;
  let submitted = 0;
  let sent = 0;
  let delivered = 0;
  let failed = 0;
  const reasons = new Map();
  for (const raw of all || []) {
    let msg;
    try { msg = JSON.parse(raw); } catch { continue; }
    if (msg?.direction !== "outbound") continue;
    outbound++;
    const status = String(msg?.status || "").toLowerCase();
    const bucket = smsDeliveryStatusBucket(status);
    submitted += bucket.submitted;
    sent += bucket.sent;
    delivered += bucket.delivered;
    failed += bucket.failed;
    if (!bucket.failed) continue;
    const payload = msg?.raw?.data?.payload || msg?.raw?.payload || msg?.raw || {};
    const errors = Array.isArray(payload?.errors) ? payload.errors : [];
    const to = Array.isArray(payload?.to) ? (payload.to[0] || {}) : {};
    const candidates = [];
    for (const err of errors) {
      candidates.push({
        code: String(err?.code || "").trim(),
        title: String(err?.title || "").trim(),
        detail: String(err?.detail || "").trim()
      });
    }
    if (!candidates.length) {
      candidates.push({
        code: String(to?.error_code || payload?.error_code || "").trim(),
        title: String(to?.status || payload?.status || status || "failed").trim(),
        detail: String(to?.error_message || payload?.error_message || "").trim()
      });
    }
    for (const item of candidates) {
      const key = item.code || item.title || item.detail || "unknown_failure";
      const current = reasons.get(key) || { code:item.code || null, title:item.title || "Unknown failure", detail:item.detail || null, count:0 };
      current.count++;
      if (!current.title && item.title) current.title=item.title;
      if (!current.detail && item.detail) current.detail=item.detail;
      reasons.set(key,current);
    }
  }
  const sorted=[...reasons.values()].sort((a,b)=>b.count-a.count);
  return {
    outbound_messages: outbound,
    failed_messages: failed,
    submitted_messages: submitted,
    sent_messages: sent,
    delivered_messages: delivered,
    failure_rate_percent: outbound ? Number(((failed/outbound)*100).toFixed(1)) : 0,
    reasons: sorted
  };
}

async function blockSmsSenderFor10dlc({ messageId = "", event = null } = {}) {
  const redis = await getAcquisitionRedis();
  const payload = event?.data?.payload || event?.payload || {};
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const codes = errors.map(e => String(e?.code || ""));
  if (!isCarrierRegistrationError(codes)) return { blocked:false, reason:"not_40010" };

  const value = {
    reason:"telnyx_10dlc_not_registered_40010",
    message_id:String(messageId || ""),
    at:new Date().toISOString()
  };
  await redis.set("recover:sms:sender-block:40010", JSON.stringify(value));
  console.error("SMS sender circuit breaker engaged", { code:"40010", messageId:String(messageId || "") });
  return { blocked:true, ...value };
}

async function backfillSmsSender10dlcBlock({ limit = 5000 } = {}) {
  const redis = await getAcquisitionRedis();
  const all = await redis.hGetAll("recover:sms:inbox:messages");
  let scanned = 0;
  for (const [id, raw] of Object.entries(all || {})) {
    if (scanned >= limit) break;
    let msg;
    try { msg = JSON.parse(raw); } catch { continue; }
    if (msg?.direction !== "outbound") continue;
    scanned++;
    const payload = msg?.raw?.data?.payload || msg?.raw?.payload || msg?.raw || {};
    const errors = Array.isArray(payload?.errors) ? payload.errors : [];
    const codes = errors.map(e => String(e?.code || ""));
    if (isCarrierRegistrationError(codes)) {
      const value = {
        reason:"telnyx_10dlc_not_registered_40010",
        message_id:String(id || ""),
        at:new Date().toISOString(),
        source:"startup_backfill"
      };
      await redis.set("recover:sms:sender-block:40010", JSON.stringify(value));
      return { blocked:true, scanned };
    }
  }
  return { blocked:false, scanned };
}

async function quarantineNonRoutableSms({ messageId = "", message = null, event = null } = {}) {
  const redis = await getAcquisitionRedis();
  let msg = message;
  if (!msg && messageId) {
    const raw = await redis.hGet("recover:sms:inbox:messages", String(messageId)).catch(() => null);
    try { msg = raw ? JSON.parse(raw) : null; } catch { msg = null; }
  }
  if (!msg?.phone) return { quarantined:false, reason:"missing_phone" };

  const payload = event?.data?.payload || event?.payload || msg?.raw?.data?.payload || msg?.raw?.payload || msg?.raw || {};
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const codes = errors.map(e => String(e?.code || ""));
  if (!codes.includes("40001")) return { quarantined:false, reason:"not_non_routable" };

  await redis.sAdd("recover:sms:suppressed", msg.phone);
  await redis.hSet("recover:sms:suppression:reasons", msg.phone, JSON.stringify({
    reason:"telnyx_non_routable_40001",
    at:new Date().toISOString(),
    source:"telnyx_delivery_failure",
    message_id:String(messageId || msg.id || "")
  }));

  let profile = null;
  try {
    const rawProfile = await redis.get(`recover:sms:inbox:contact:${msg.phone}`);
    profile = rawProfile ? JSON.parse(rawProfile) : null;
  } catch {}

  const metadata = {
    sheet_spreadsheet_id: profile?.sheet_spreadsheet_id || SMS_BULK_SPREADSHEET_ID,
    sheet_tab_name: profile?.sheet_tab_name || SMS_BULK_TAB_NAME,
    sheet_row: profile?.sheet_row || null
  };
  if (metadata.sheet_spreadsheet_id && metadata.sheet_tab_name && metadata.sheet_row) {
    await SMS_SHEET_BRIDGE.writeBasicSendResult({
      status:"blocked_not_routable",
      telnyx_message_id:String(messageId || msg.id || ""),
      at:new Date().toISOString()
    }, metadata).catch(error => console.error("SMS non-routable sheet writeback error", error?.message || error));
  }

  console.log("SMS number quarantined as non-routable", {
    messageId:String(messageId || msg.id || ""),
    sheetRow: metadata.sheet_row || null,
    phoneHint:`••••${String(msg.phone).slice(-4)}`
  });
  return { quarantined:true, sheet_row:metadata.sheet_row || null };
}

async function backfillNonRoutableSmsSuppressions({ limit = 5000 } = {}) {
  const redis = await getAcquisitionRedis();
  const all = await redis.hGetAll("recover:sms:inbox:messages");
  let scanned=0, quarantined=0;
  for (const [id, raw] of Object.entries(all || {})) {
    if (scanned >= limit) break;
    let msg;
    try { msg = JSON.parse(raw); } catch { continue; }
    if (msg?.direction !== "outbound") continue;
    scanned++;
    const result = await quarantineNonRoutableSms({ messageId:id, message:msg });
    if (result?.quarantined) quarantined++;
  }
  return { scanned, quarantined };
}

async function reconcileAmbiguousLookupSuppressions({ limit = 5000 } = {}) {
  const redis = await getAcquisitionRedis();
  const reasons = await redis.hGetAll("recover:sms:suppression:reasons");
  let scanned = 0;
  let restoredToCheck = 0;
  for (const [phone, raw] of Object.entries(reasons || {})) {
    if (scanned >= limit) break;
    scanned++;
    let reason = null;
    try { reason = raw ? JSON.parse(raw) : null; } catch {}
    if (reason?.reason !== "telnyx_lookup_not_sms_capable") continue;
    const type = String(reason?.line_type || "").toLowerCase().replace(/[\s-]+/g, "_");
    if (!["voip","fixed_line_or_mobile","unknown",""].includes(type)) continue;

    await redis.sRem("recover:sms:suppressed", phone);
    const row = Number(reason?.sheet_row || 0);
    if (row > 0 && SMS_BULK_SPREADSHEET_ID && SMS_BULK_TAB_NAME) {
      await SMS_SHEET_BRIDGE.writeBasicReachability("CHECK", {
        sheet_spreadsheet_id: SMS_BULK_SPREADSHEET_ID,
        sheet_tab_name: SMS_BULK_TAB_NAME,
        sheet_row: row
      }, `ambiguous_${type || "unknown"}`).catch(error =>
        console.error("SMS ambiguous lookup CHECK repair error", error?.message || error)
      );
    }
    await redis.hSet("recover:sms:suppression:reasons", phone, JSON.stringify({
      ...reason,
      reason:"telnyx_lookup_ambiguous_requires_check",
      restored_at:new Date().toISOString()
    }));
    restoredToCheck++;
  }
  return { scanned, restored_to_check: restoredToCheck };
}

async function listUnavailableSmsNumbers({ limit = 500 } = {}) {
  const redis = await getAcquisitionRedis();
  const reasons = await redis.hGetAll("recover:sms:suppression:reasons");
  const items = [];
  for (const [phone, raw] of Object.entries(reasons || {})) {
    let reason = null;
    try { reason = raw ? JSON.parse(raw) : null; } catch {}
    if (reason?.reason !== "telnyx_non_routable_40001") continue;
    let profile = null;
    try {
      const rawProfile = await redis.get(`recover:sms:inbox:contact:${phone}`);
      profile = rawProfile ? JSON.parse(rawProfile) : null;
    } catch {}
    items.push({
      business_name: profile?.business_name || null,
      phone_masked: phone ? `••••${String(phone).slice(-4)}` : null,
      sheet_row: profile?.sheet_row || null,
      sheet_tab_name: profile?.sheet_tab_name || null,
      reason: "Not routable — landline or non-routable wireless number",
      telnyx_code: "40001",
      marked_not_available: true,
      suppressed: true
    });
    if (items.length >= limit) break;
  }
  return { count: items.length, items };
}

async function listInboxThreads(limit = 100) {
  const redis = await getAcquisitionRedis();
  const phones = await redis.zRange("recover:sms:inbox:threads", 0, Math.max(0, limit - 1), { REV: true });
  const replyPhones = new Set(await redis.zRange("recover:sms:inbox:reply-threads", 0, -1));
  const messagesHash = "recover:sms:inbox:messages";
  const out = [];
  for (const phone of phones) {
    const ids = await redis.zRange(`recover:sms:inbox:thread:${phone}`, 0, 0, { REV: true });
    const latestRaw = ids[0] ? await redis.hGet(messagesHash, ids[0]) : null;
    const latest = latestRaw ? JSON.parse(latestRaw) : null;
    let profile = null;
    try {
      const rawProfile = await redis.get(`recover:sms:inbox:contact:${phone}`);
      profile = rawProfile ? JSON.parse(rawProfile) : null;
    } catch {}
    let latestInboundScore = 0;
    let readScore = 0;
    try {
      latestInboundScore = Number(await redis.zScore("recover:sms:inbox:reply-threads", phone) || 0);
      readScore = Number(await redis.hGet("recover:sms:inbox:read", phone) || 0);
    } catch {}
    const replied = replyPhones.has(phone);
    const unread_reply = replied && latestInboundScore > readScore;
    out.push({ phone, latest, profile, replied, unread_reply, latest_inbound_at: latestInboundScore || null });
  }
  return out;
}

async function markInboxThreadRead(phone) {
  const redis = await getAcquisitionRedis();
  const normalized = normalizeInboxPhone(phone);
  if (!normalized) throw new Error("invalid_phone");
  const latestInboundScore = Number(await redis.zScore("recover:sms:inbox:reply-threads", normalized) || 0);
  const readScore = latestInboundScore || Date.now();
  await redis.hSet("recover:sms:inbox:read", normalized, String(readScore));
  return { phone: normalized, read_at: readScore, had_reply: latestInboundScore > 0 };
}

async function readInboxThread(phone, limit = 300) {
  const redis = await getAcquisitionRedis();
  const normalized = normalizeInboxPhone(phone);
  const ids = await redis.zRange(`recover:sms:inbox:thread:${normalized}`, 0, Math.max(0, limit - 1), { REV: false });
  if (!ids.length) return { phone: normalized, messages: [] };
  const values = await redis.hmGet("recover:sms:inbox:messages", ids);
  const messages = values.map((raw) => {
    try { return raw ? JSON.parse(raw) : null; } catch { return null; }
  }).filter(Boolean);
  let profile = null;
  try {
    const rawProfile = await redis.get(`recover:sms:inbox:contact:${normalized}`);
    profile = rawProfile ? JSON.parse(rawProfile) : null;
  } catch {}
  return { phone: normalized, profile, messages };
}

async function rebuildInboxReplyIndex() {
  const redis = await getAcquisitionRedis();
  const values = await redis.hVals("recover:sms:inbox:messages");
  const latestByPhone = new Map();
  let inboundMessages = 0;
  for (const raw of values || []) {
    let message;
    try { message = raw ? JSON.parse(raw) : null; } catch { continue; }
    if (!message || message.direction !== "inbound") continue;
    const phone = normalizeInboxPhone(message.phone);
    if (!phone) continue;
    inboundMessages++;
    const score = Math.max(0, Date.parse(message.at || "") || Date.now());
    if (!latestByPhone.has(phone) || score > latestByPhone.get(phone)) latestByPhone.set(phone, score);
  }
  if (latestByPhone.size) {
    await redis.zAdd("recover:sms:inbox:reply-threads", [...latestByPhone.entries()].map(([value, score]) => ({ score, value })));
  }
  return { reply_threads: latestByPhone.size, inbound_messages: inboundMessages };
}

async function backfillInboxFromSmsBatches({ maxBatches = 250 } = {}) {
  const redis = await getAcquisitionRedis();
  let cursor = "0";
  const batchKeys = [];
  do {
    const page = await redis.scan(cursor, { MATCH: "recover:sms:batch:*", COUNT: 200 });
    cursor = String(page?.cursor ?? "0");
    for (const key of page?.keys || []) {
      if (/^recover:sms:batch:[^:]+$/.test(String(key))) batchKeys.push(String(key));
      if (batchKeys.length >= maxBatches) break;
    }
  } while (cursor !== "0" && batchKeys.length < maxBatches);

  let scanned = 0, accepted = 0, restored = 0, skipped = 0;
  for (const key of batchKeys) {
    scanned++;
    let batch;
    try {
      const raw = await redis.get(key);
      batch = raw ? JSON.parse(raw) : null;
    } catch { continue; }
    if (!batch || !Array.isArray(batch.recipients)) continue;
    const batchId = String(batch.id || key.slice("recover:sms:batch:".length));
    const resultsRaw = await redis.lRange(`recover:sms:batch:${batchId}:results`, 0, -1).catch(() => []);
    for (const rawResult of resultsRaw || []) {
      let result;
      try { result = JSON.parse(rawResult); } catch { continue; }
      if (result?.status !== "accepted" || !result?.telnyx_message_id) { skipped++; continue; }
      const index = Number(result.index);
      const messageIndex = Number(result.message_index || 0);
      const recipient = Number.isInteger(index) ? batch.recipients[index] : null;
      if (!recipient?.phone) { skipped++; continue; }
      const existingInboxRaw = await redis.hGet("recover:sms:inbox:messages", String(result.telnyx_message_id)).catch(() => null);
      if (existingInboxRaw) { accepted++; skipped++; continue; }
      const messages = Array.isArray(recipient.messages) ? recipient.messages : [];
      const original = String(messages[messageIndex] || recipient.message || "");
      const outboundText = String(original || "");
      await saveInboxMessage({
        id: result.telnyx_message_id,
        phone: recipient.phone,
        direction: "outbound",
        text: outboundText,
        status: "accepted",
        at: result.at || batch.started_at || batch.created_at || new Date().toISOString(),
        raw: { backfilled: true, batch_id: batchId, index, message_index: messageIndex }
      }).catch(() => null);
      await saveInboxContactProfile(recipient.phone, recipient.metadata || {}).catch(() => null);
      accepted++;
      restored++;
    }
  }
  return { scanned_batches: scanned, accepted_results: accepted, restored_messages: restored, skipped };
}

async function repairBackfilledInboxBodiesFromTelnyx({ limit = 500 } = {}) {
  if (!TELNYX_API_KEY) return { scanned: 0, repaired: 0, skipped: 0, failed: 0 };
  const redis = await getAcquisitionRedis();
  const all = await redis.hGetAll("recover:sms:inbox:messages");
  let scanned = 0, repaired = 0, skipped = 0, failed = 0;
  for (const [id, raw] of Object.entries(all || {})) {
    if (scanned >= limit) break;
    let existing;
    try { existing = JSON.parse(raw); } catch { skipped++; continue; }
    if (existing?.direction !== "outbound" || !existing?.raw?.backfilled) { skipped++; continue; }
    scanned++;
    try {
      const remote = await telnyxApiRequest(`/messages/${encodeURIComponent(id)}`);
      const remoteText = String(remote?.data?.text || "");
      if (!remoteText) { skipped++; continue; }
      const next = { ...existing, text: remoteText, raw: remote?.data || existing.raw };
      await redis.hSet("recover:sms:inbox:messages", id, JSON.stringify(next));
      repaired++;
    } catch (error) {
      failed++;
      console.error("Inbox Telnyx body repair error", { id, error: error?.message || String(error) });
    }
  }
  return { scanned, repaired, skipped, failed };
}

function telnyxWebhookTarget() {
  if (TELNYX_AUTO_CONFIGURE_PROFILE && RAILWAY_PUBLIC_DOMAIN && MCP_AUTH_TOKEN) {
    return `https://${RAILWAY_PUBLIC_DOMAIN}/webhooks/telnyx?token=${inboxWebhookToken()}`;
  }
  if (TELNYX_WEBHOOK_URL) return TELNYX_WEBHOOK_URL;
  if (!RAILWAY_PUBLIC_DOMAIN || !MCP_AUTH_TOKEN) return "";
  return `https://${RAILWAY_PUBLIC_DOMAIN}/webhooks/telnyx?token=${inboxWebhookToken()}`;
}

function inboxLoginHtml(error = "") {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"><title>Recover Inbox</title><style>
  *{box-sizing:border-box}body{margin:0;background:#0a0c0f;color:#f6f7f8;font-family:Inter,system-ui,-apple-system,sans-serif;min-height:100vh;display:grid;place-items:center;padding:24px}.card{width:min(420px,100%);background:#11151a;border:1px solid #262c34;border-radius:22px;padding:28px}.brand{font-size:21px;font-weight:800}.muted{color:#929ba7}.err{background:#30191c;color:#ffc1c5;padding:10px;border-radius:10px;margin:12px 0}input{width:100%;background:#0d1014;color:white;border:1px solid #333a44;border-radius:12px;padding:13px;margin:8px 0 12px;font-size:16px}button{width:100%;border:0;border-radius:12px;padding:13px;font-weight:800;background:#f4f4f3;color:#111}</style></head><body><form class="card" method="post" action="/inbox/login"><div class="brand">Recover Inbox</div><p class="muted">Your Telnyx SMS conversations</p>${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}<label>Password</label><input name="password" type="password" required autofocus autocomplete="current-password"><button type="submit">Open inbox</button></form></body></html>`;
}

function inboxAppHtml() {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta charset="utf-8"><meta name="theme-color" content="#0a0c0f"><title>Recover Inbox</title><style>
  :root{color-scheme:dark}*{box-sizing:border-box}html,body{height:100%;overflow:hidden}body{margin:0;background:#090b0e;color:#f5f6f7;font:14px/1.4 Inter,system-ui,-apple-system,sans-serif}.app{height:100dvh;min-height:0;overflow:hidden;display:grid;grid-template-columns:340px 1fr}.side{height:100%;min-height:0;overflow:hidden;background:#0d1014;border-right:1px solid #242a32;display:flex;flex-direction:column;min-width:0}.head{padding:13px 14px;border-bottom:1px solid #242a32;display:flex;justify-content:space-between;align-items:center;gap:10px}.brand{font-weight:850;font-size:18px;letter-spacing:-.02em}.topStats{color:#7e8792;font-size:11px;margin-top:2px;white-space:nowrap}.topActions{display:flex;gap:6px;align-items:center;flex:none}.iconBtn{width:34px;height:34px;padding:0;border:1px solid #2d343d;border-radius:10px;background:#151a20;color:#d9dfe6;display:grid;place-items:center;font-size:16px;font-weight:800;cursor:pointer}.iconBtn:hover{background:#1b2128}.refreshCircle{border-radius:50%;font-size:17px}.refreshCircle:active{transform:rotate(35deg)}.liveStatus{height:34px;padding:0 10px;border-radius:10px;border:1px solid #1f4e34;background:#10251a;color:#79d9a3;font-size:10px;font-weight:850;display:flex;align-items:center;gap:6px;cursor:default}.liveStatus.live{border-color:#1f4e34;background:#10251a;color:#79d9a3}.liveStatus.offline{border-color:#6a242a;background:#30191c;color:#ff9ca6}.liveStatus.offline .livePulse{background:#ff5f6d;box-shadow:0 0 8px rgba(255,95,109,.8)}.green{font-size:10px;color:#79d9a3;background:#10251a;border:1px solid #1f4e34;border-radius:999px;padding:4px 7px}.search{margin:10px 12px 8px;border:1px solid #303741;background:#11151a;color:#fff;border-radius:11px;padding:10px 12px;outline:none}.search:focus{border-color:#4a5563;box-shadow:0 0 0 2px rgba(255,255,255,.035)}.list{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}.row{padding:11px 14px;border-bottom:1px solid #1c2127;cursor:pointer;position:relative}.row:hover,.row.active{background:#151a20}.row.reply{padding-left:38px}.replyDot{position:absolute;left:16px;top:20px;width:10px;height:10px;border-radius:50%;background:#66f0a5;box-shadow:0 0 0 3px rgba(102,240,165,.12),0 0 12px rgba(102,240,165,.9);animation:pulse 1.8s ease-in-out infinite}.replyLabel{display:inline-flex;align-items:center;gap:5px;margin-top:5px;padding:2px 7px;border-radius:999px;background:#10251a;border:1px solid #1f4e34;color:#79d9a3;font-size:10px;font-weight:800}.filters{display:flex;gap:7px;padding:0 12px 12px;flex-wrap:wrap}.filter{border:1px solid #2d343d;background:#11151a;color:#89939f;border-radius:999px;padding:6px 10px;font-size:11px;font-weight:750;cursor:pointer}.filter.active{background:#f1f2f3;color:#101215;border-color:#f1f2f3}.phone{font-weight:750}@keyframes pulse{0%,100%{transform:scale(.9);opacity:.78}50%{transform:scale(1.18);opacity:1}}.preview{color:#929ba7;margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.time{font-size:10px;color:#68717c;margin-top:2px}.draftLabel{display:inline-flex;align-items:center;margin-left:6px;padding:1px 6px;border-radius:999px;background:#2a2414;color:#f3cf72;border:1px solid #5c4b1f;font-size:9px;font-weight:850;vertical-align:1px}.thread{height:100%;min-height:0;overflow:hidden;display:grid;grid-template-rows:auto minmax(0,1fr) auto;min-width:0}.threadHead{padding:14px 18px;border-bottom:1px solid #242a32;background:#0d1014;display:flex;gap:10px;align-items:center}.msgs{min-height:0;overflow:auto;overscroll-behavior:contain;padding:20px;display:flex;flex-direction:column;gap:9px}.bubble{max-width:min(76%,680px);padding:10px 13px;border-radius:16px;white-space:pre-wrap;word-break:break-word}.bubble a{color:#2f7cf6;text-decoration:underline;text-underline-offset:2px;overflow-wrap:anywhere}.out a{color:#075ac8}.in{align-self:flex-start;background:#191f26;border:1px solid #29323c}.out{align-self:flex-end;background:#f0f1f2;color:#111}.meta{font-size:10px;opacity:.58;margin-top:5px}.composer{display:grid;grid-template-columns:1fr auto;gap:8px;padding:12px;border-top:1px solid #242a32;background:#0d1014}.composer textarea{min-height:48px;max-height:140px;resize:none;background:#11151a;color:#fff;border:1px solid #303741;border-radius:12px;padding:12px;font:inherit}.composer button,.smallbtn{border:0;border-radius:11px;font-weight:750}.composer button{padding:0 15px;background:#f0f1f2;color:#111}.smallbtn{padding:8px 10px;background:#171c22;color:#cbd1d7;cursor:pointer}.smallbtn:disabled{opacity:.5;cursor:not-allowed}.livePulse{display:inline-block;width:6px;height:6px;border-radius:50%;background:#66f0a5;margin-right:5px;box-shadow:0 0 8px rgba(102,240,165,.8)}.statusBadge{display:inline-flex;align-items:center;gap:4px;margin-left:6px;padding:1px 6px;border-radius:999px;font-size:9px;font-weight:800;background:#222831;color:#8e98a5}.statusBadge.delivered{background:#10251a;color:#79d9a3}.statusBadge.failed{background:#30191c;color:#ffc2c6}.notifyOn{color:#79d9a3;border-color:#1f4e34}.empty{display:grid;place-items:center;color:#707a86;padding:28px;text-align:center}.mobileBack{display:none}.error{padding:9px 12px;background:#30191c;color:#ffc2c6}.toast{position:fixed;right:18px;bottom:18px;z-index:20;background:#171c22;border:1px solid #303843;border-radius:12px;padding:10px 13px;color:#dce2e8;box-shadow:0 10px 35px rgba(0,0,0,.35);opacity:0;transform:translateY(8px);pointer-events:none;transition:.18s}.toast.show{opacity:1;transform:none}.replyMeta{color:#66d998;font-weight:800}.failurePanel{display:none;margin:0 12px 12px;border:1px solid #3a2a2d;background:#171113;border-radius:12px;padding:10px 12px;color:#d8c8ca}.failurePanel.show{display:block}.failureItem{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-top:1px solid #2a2023}.failureItem:first-child{border-top:0}.failureCount{font-weight:850;color:#ff9ea7;flex:none}.failureTitle{font-weight:750}.failureDetail{font-size:11px;color:#8e7f82;margin-top:2px}.undoBar{position:fixed;left:50%;bottom:20px;transform:translate(-50%,18px);z-index:25;display:flex;align-items:center;gap:12px;background:#f1f2f3;color:#111;border-radius:14px;padding:10px 12px 10px 14px;box-shadow:0 18px 50px rgba(0,0,0,.4);opacity:0;pointer-events:none;transition:.18s;min-width:280px;justify-content:space-between}.undoBar.show{opacity:1;transform:translate(-50%,0);pointer-events:auto}.undoBar button{border:0;background:#111;color:#fff;border-radius:9px;padding:7px 10px;font-weight:800;cursor:pointer}.pendingBubble{opacity:.65;border-style:dashed!important}.composeOverlay{position:fixed;inset:0;z-index:40;background:rgba(0,0,0,.58);display:none;align-items:flex-start;justify-content:center;padding:72px 16px 16px}.composeOverlay.show{display:flex}.composeCard{width:min(520px,100%);background:#0f1318;border:1px solid #2b333d;border-radius:16px;box-shadow:0 24px 80px rgba(0,0,0,.55);overflow:hidden}.composeHead{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #242a32}.composeTitle{font-weight:850;font-size:16px}.closeBtn{width:30px;height:30px;border:0;border-radius:9px;background:#171c22;color:#cbd1d7;cursor:pointer}.composeBody{padding:14px 16px;display:grid;gap:10px}.composeBody input,.composeBody textarea{width:100%;background:#11151a;color:#fff;border:1px solid #303741;border-radius:11px;padding:11px 12px;font:inherit;outline:none}.composeBody textarea{min-height:150px;resize:vertical}.composeBody input:focus,.composeBody textarea:focus{border-color:#4a5563}.composeActions{display:flex;justify-content:flex-end;gap:8px;padding:0 16px 16px}.composeActions button{border:0;border-radius:10px;padding:10px 14px;font-weight:800;cursor:pointer}.composeCancel{background:#171c22;color:#cbd1d7}.composeSend{background:#f0f1f2;color:#111}
  @media(max-width:720px){.app{display:block}.side{height:100dvh;border:0}.thread{height:100dvh;display:none}.app.open .side{display:none}.app.open .thread{display:grid}.mobileBack{display:inline-block}.bubble{max-width:88%}.msgs{padding:14px}}
  </style></head><body><div class="app" id="app"><aside class="side"><div class="head" style="position:sticky;top:0;z-index:5;background:#0d1014"><div><div class="brand">Recover Inbox</div><div id="inboxCount" class="topStats">Loading…</div></div><div class="topActions"><button id="composeNew" class="iconBtn" type="button" title="New message" aria-label="New message">✎</button><button id="refresh" class="iconBtn refreshCircle" type="button" title="Refresh inbox" aria-label="Refresh inbox">↻</button><button id="liveState" class="liveStatus live" type="button" title="Messaging is live" aria-label="Messaging status"><span class="livePulse"></span><span id="liveLabel">LIVE</span></button></div></div><input id="search" class="search" placeholder="Search business, number, or message"><div class="filters"><button class="filter active" data-filter="all" type="button">All</button><button class="filter" data-filter="replies" type="button">Replies <span id="replyCount">0</span></button><button class="filter" data-filter="unread" type="button">Unread <span id="unreadCount">0</span></button><button class="filter" data-filter="drafts" type="button">Drafts <span id="draftCount">0</span></button><button class="filter" id="failuresBtn" type="button">Failures <span id="failedCount">0</span></button></div><div id="failurePanel" class="failurePanel"></div><div id="err"></div><div id="list" class="list"><div class="empty">Loading…</div></div><div class="head" style="border-top:1px solid #242a32;border-bottom:0"><span style="font-size:11px;color:#69727d">Auto-refreshes automatically</span><form method="post" action="/inbox/logout"><button class="smallbtn" type="submit">Log out</button></form></div></aside><main class="thread"><div class="threadHead"><button id="back" class="smallbtn mobileBack">←</button><div><strong id="threadPhone">Conversation</strong><div id="threadSub" style="color:#75808c;font-size:11px">SMS conversation</div></div></div><div id="messages" class="msgs"><div class="empty">Choose a conversation</div></div><form id="composer" class="composer"><textarea id="reply" maxlength="1600" placeholder="Write a reply…" disabled></textarea><button id="send" disabled>Send</button></form></main></div><div id="toast" class="toast"></div><div id="undoBar" class="undoBar"><span id="undoText">Sending in 10s…</span><button id="undoSend" type="button">Undo send</button></div><div id="composeOverlay" class="composeOverlay"><div class="composeCard" role="dialog" aria-modal="true" aria-labelledby="composeTitle"><div class="composeHead"><div id="composeTitle" class="composeTitle">New message</div><button id="composeClose" class="closeBtn" type="button" aria-label="Close">×</button></div><div class="composeBody"><input id="composePhone" type="tel" placeholder="+1 555 123 4567" autocomplete="tel"><textarea id="composeText" maxlength="1600" placeholder="Write your message…"></textarea></div><div class="composeActions"><button id="composeCancel" class="composeCancel" type="button">Cancel</button><button id="composeSend" class="composeSend" type="button">Send</button></div></div></div><script>
  const state={threads:[],selected:"",filter:"all",sse:null,lastInboundId:"",pendingSend:null,drafts:{}};const q=id=>document.getElementById(id),app=q("app");
  const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const linkify=s=>esc(s).replace(/(https?:\\/\\/[^\\s<]+)/g,'<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  const fmt=t=>{const d=new Date(t||0);return Number.isNaN(d.getTime())?"":d.toLocaleString([], {month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})};
  const statusHtml=m=>{const st=String(m?.status||"").toLowerCase();const label=st||"";const cls=/deliver/.test(st)?"delivered":/fail|undeliver|error/.test(st)?"failed":"";return label?'<span class="statusBadge '+cls+'">'+esc(label)+'</span>':""};
  function loadDraftStore(){try{return JSON.parse(localStorage.getItem("recover_inbox_drafts")||"{}")||{}}catch{return {}}}
  function persistDraftStore(){try{localStorage.setItem("recover_inbox_drafts",JSON.stringify(state.drafts))}catch{}}
  function draftFor(phone){return String(state.drafts?.[phone]||"")}
  function saveDraft(phone,text,{quiet=false}={}){if(!phone)return;const value=String(text||"").trim();if(value)state.drafts[phone]=value;else delete state.drafts[phone];persistDraftStore();updateDraftCount();render();if(!quiet)toast(value?"Draft saved":"Draft cleared")}
  function clearDraft(phone){if(!phone)return;delete state.drafts[phone];persistDraftStore();updateDraftCount();render()}
  function updateDraftCount(){const n=Object.keys(state.drafts||{}).filter(phone=>String(state.drafts[phone]||"").trim()).length;q("draftCount").textContent=n}
  async function api(url,opts={}){const r=await fetch(url,{cache:"no-store",...opts,headers:{"content-type":"application/json",...(opts.headers||{})}});const j=await r.json().catch(()=>({}));if(r.status===401){location.href="/inbox";throw new Error("Session expired")}if(!r.ok)throw new Error(j.error||"Request failed");return j}
  function error(m){q("err").innerHTML=m?'<div class="error">'+esc(m)+'</div>':""}
  function filtered(){const term=q("search").value.toLowerCase().trim();let rows=state.threads;if(state.filter==="replies")rows=state.threads.filter(x=>x.replied);if(state.filter==="unread")rows=state.threads.filter(x=>x.unread_reply);if(state.filter==="drafts")rows=state.threads.filter(x=>draftFor(x.phone));return term?rows.filter(x=>JSON.stringify(x).toLowerCase().includes(term)):rows}
  function render(){const rows=filtered();q("list").innerHTML=rows.length?rows.map(x=>'<div class="row '+(x.unread_reply?"reply ":"")+(x.phone===state.selected?"active":"")+'" data-phone="'+esc(x.phone)+'">'+(x.unread_reply?'<span class="replyDot" title="Unread customer reply"></span>':'')+'<div class="phone">'+esc(x.profile?.business_name||x.phone)+(draftFor(x.phone)?'<span class="draftLabel">DRAFT</span>':'')+'</div><div style="color:#68717d;font-size:11px">'+esc(x.profile?.business_name?x.phone:"")+'</div><div class="preview">'+esc(draftFor(x.phone)||x.latest?.text||"No preview")+'</div>'+(x.unread_reply?'<div class="replyLabel">● NEW REPLY</div>':x.replied?'<div class="replyLabel" style="opacity:.55">REPLIED</div>':'')+'<div class="time">'+esc(fmt(x.latest?.at))+'</div></div>').join(""):'<div class="empty">'+(state.filter==="replies"?"No replied conversations yet.":state.filter==="unread"?"No unread replies.":state.filter==="drafts"?"No saved drafts.":"No SMS conversations yet.")+'</div>';document.querySelectorAll(".row").forEach(r=>r.onclick=()=>openThread(r.dataset.phone,{markRead:true}))}
  function toast(message){const t=q("toast");t.textContent=message;t.classList.add("show");clearTimeout(window.__toastTimer);window.__toastTimer=setTimeout(()=>t.classList.remove("show"),2200)}
  async function load({sync=false}={}){try{error("");if(sync){const synced=await api("/inbox/api/sync",{method:"POST",body:"{}"});toast("Synced "+(synced.restored_messages||0)+" outbound messages · "+(synced.reply_threads||0)+" reply threads")}const [j,stats]=await Promise.all([api("/inbox/api/threads"),api("/inbox/status")]);state.threads=j.threads||[];const replied=Number(stats.reply_threads??state.threads.filter(x=>x.replied).length);const unread=Number(stats.unread_replies??state.threads.filter(x=>x.unread_reply).length);q("replyCount").textContent=replied;q("unreadCount").textContent=unread;q("failedCount").textContent=(stats.failed_messages??0);q("inboxCount").textContent=(stats.threads??state.threads.length)+" conv · "+(stats.sent_messages??0)+" sent · "+(stats.submitted_messages??0)+" pending · "+(stats.failed_messages??0)+" failed";render();if(!state.selected&&state.threads.length&&window.innerWidth>720){await openThread(state.threads[0].phone,{markRead:false})}}catch(e){error(e.message)}}
  async function openThread(phone,{markRead=true}={}){state.selected=phone;app.classList.add("open");let selected=state.threads.find(x=>x.phone===phone);q("threadPhone").innerHTML=esc(selected?.profile?.business_name||phone)+(selected?.unread_reply?' <span class="replyMeta">● New reply</span>':selected?.replied?' <span class="replyMeta" style="opacity:.65">● Replied</span>':'');q("threadSub").textContent=(selected?.profile?.business_name?phone+" · ":"")+"SMS conversation";q("messages").innerHTML='<div class="empty">Loading…</div>';try{const j=await api("/inbox/api/thread?phone="+encodeURIComponent(phone));q("messages").innerHTML=(j.messages||[]).map(m=>'<div class="bubble '+(m.direction==="outbound"?"out":"in")+'">'+linkify(m.text||"")+'<div class="meta">'+esc(fmt(m.at))+statusHtml(m)+'</div></div>').join("")||'<div class="empty">No messages yet.</div>';q("messages").scrollTop=q("messages").scrollHeight;q("reply").disabled=false;q("send").disabled=false;const savedDraft=draftFor(phone);if(savedDraft&&!q("reply").value.trim())q("reply").value=savedDraft;if(markRead&&selected?.unread_reply){await api("/inbox/api/read",{method:"POST",body:JSON.stringify({phone})});selected.unread_reply=false;const replied=state.threads.filter(x=>x.replied).length;const unread=state.threads.filter(x=>x.unread_reply).length;q("replyCount").textContent=replied;q("unreadCount").textContent=unread;const stats=await api("/inbox/status");q("inboxCount").textContent=(stats.threads??state.threads.length)+" conv · "+(stats.sent_messages??0)+" sent · "+(stats.submitted_messages??0)+" pending · "+(stats.failed_messages??0)+" failed";render();q("threadPhone").innerHTML=esc(selected?.profile?.business_name||phone)+(selected?.replied?' <span class="replyMeta" style="opacity:.65">● Replied</span>':'')}}catch(e){error(e.message)}}
  function clearPendingBubble(){document.querySelectorAll("[data-pending-send]").forEach(el=>el.remove())}
  function hideUndo(){q("undoBar").classList.remove("show")}
  function cancelPendingSend(){if(!state.pendingSend)return;clearTimeout(state.pendingSend.timer);state.pendingSend=null;clearPendingBubble();hideUndo();q("send").disabled=false;toast("Message unsent")}
  async function commitPendingSend(pending){if(!pending||state.pendingSend!==pending)return;state.pendingSend=null;hideUndo();try{await api("/inbox/api/reply",{method:"POST",body:JSON.stringify({phone:pending.phone,text:pending.text})});if(state.selected===pending.phone)await openThread(pending.phone,{markRead:false});await load()}catch(e){error(e.message);toast("Send failed")}finally{q("send").disabled=false;clearPendingBubble()}}
  q("composer").onsubmit=e=>{e.preventDefault();const text=q("reply").value.trim();if(!text||!state.selected)return;if(state.pendingSend){toast("Undo or wait for the pending message first");return}const pending={phone:state.selected,text,timer:null};state.pendingSend=pending;clearDraft(state.selected);q("reply").value="";q("send").disabled=true;const wrap=document.createElement("div");wrap.className="bubble out pendingBubble";wrap.setAttribute("data-pending-send","1");wrap.innerHTML=linkify(text)+'<div class="meta">Sending in 10 seconds · Undo available</div>';q("messages").appendChild(wrap);q("messages").scrollTop=q("messages").scrollHeight;q("undoText").textContent="Sending in 10s…";q("undoBar").classList.add("show");let left=10;const countdown=setInterval(()=>{if(state.pendingSend!==pending){clearInterval(countdown);return}left--;q("undoText").textContent="Sending in "+Math.max(0,left)+"s…";if(left<=0)clearInterval(countdown)},1000);pending.timer=setTimeout(()=>commitPendingSend(pending),10000)};
  async function toggleFailures(){const panel=q("failurePanel");const btn=q("failuresBtn");if(panel.classList.contains("show")&&panel.dataset.mode==="failures"){panel.classList.remove("show");btn.classList.remove("active");return}panel.dataset.mode="failures";document.querySelectorAll(".filter").forEach(x=>x.classList.remove("active"));btn.classList.add("active");panel.innerHTML='<div class="empty" style="padding:8px">Loading failure details…</div>';panel.classList.add("show");try{const [data,unavailable]=await Promise.all([api("/inbox/failures"),api("/inbox/unavailable")]);q("failedCount").textContent=data.failed_messages||0;const rows=data.reasons||[];const unavailableCount=unavailable.count||0;panel.innerHTML='<div style="font-weight:850;margin-bottom:8px">'+esc(data.failed_messages||0)+' failed · '+esc(data.failure_rate_percent||0)+'% failure rate</div>'+(rows.length?rows.slice(0,12).map(r=>'<div class="failureItem"><div><div class="failureTitle">'+esc(r.title||"Unknown failure")+(r.code?' · '+esc(r.code):'')+'</div>'+(r.detail?'<div class="failureDetail">'+esc(r.detail)+'</div>':'')+'</div><div class="failureCount">'+esc(r.count)+'</div></div>').join(""):'<div class="failureDetail">No failure reasons stored yet.</div>')+'<div class="failureItem" style="margin-top:4px"><div><div class="failureTitle">Unavailable numbers</div><div class="failureDetail">Marked Not Available and automatically skipped on future sends</div></div><div class="failureCount">'+esc(unavailableCount)+'</div></div>'}catch(e){panel.innerHTML='<div class="error">'+esc(e.message)+'</div>'}}
  function notifyInbound(){return}
  function connectLive(){if(state.sse)try{state.sse.close()}catch{};const es=new EventSource("/inbox/events");state.sse=es;es.onopen=()=>{q("liveState").classList.add("live");q("liveState").classList.remove("offline");q("liveLabel").textContent="LIVE";q("liveState").title="Messaging is live"};es.onerror=()=>{q("liveState").classList.remove("live");q("liveState").classList.add("offline");q("liveLabel").textContent="OFFLINE";q("liveState").title="Messaging connection is offline"};es.onmessage=async e=>{let ev;try{ev=JSON.parse(e.data)}catch{return}if(ev.type==="message"||ev.type==="status"){const wasSelected=state.selected===ev.phone;await load();const thread=state.threads.find(x=>x.phone===ev.phone);if(ev.type==="message"&&ev.direction==="inbound"&&ev.id!==state.lastInboundId){state.lastInboundId=ev.id;if(!wasSelected||document.hidden)notifyInbound(thread);if(wasSelected&&!document.hidden)await openThread(ev.phone,{markRead:true});else if(state.filter==="unread"||state.filter==="replies")render() } else if(wasSelected) await openThread(ev.phone,{markRead:false});}}}
  state.drafts=loadDraftStore();updateDraftCount();let draftTimer=null;q("reply").addEventListener("input",()=>{clearTimeout(draftTimer);draftTimer=setTimeout(()=>{if(state.selected)saveDraft(state.selected,q("reply").value,{quiet:true})},650)});
  function normalizeComposePhone(value){const raw=String(value||"").trim();const digits=raw.replace(/\D/g,"");if(!digits)return "";return "+"+digits}
  function openCompose(){q("composeOverlay").classList.add("show");q("composePhone").value="";q("composeText").value="";setTimeout(()=>q("composePhone").focus(),0)}
  function closeCompose(){q("composeOverlay").classList.remove("show")}
  async function sendCompose(){const phone=normalizeComposePhone(q("composePhone").value);const text=q("composeText").value.trim();if(!phone||phone.length<8){toast("Enter a valid phone number");return}if(!text){toast("Write a message first");return}q("composeSend").disabled=true;try{const result=await api("/inbox/api/reply",{method:"POST",body:JSON.stringify({phone,text})});closeCompose();toast("Message sent");await load();const target=state.threads.find(x=>x.phone===phone);if(target)await openThread(phone,{markRead:false})}catch(e){toast(e.message||"Send failed")}finally{q("composeSend").disabled=false}}
  q("composeNew").onclick=openCompose;q("composeClose").onclick=closeCompose;q("composeCancel").onclick=closeCompose;q("composeSend").onclick=sendCompose;q("composeOverlay").addEventListener("click",e=>{if(e.target===q("composeOverlay"))closeCompose()});q("composeText").addEventListener("keydown",e=>{if((e.metaKey||e.ctrlKey)&&e.key==="Enter"){e.preventDefault();sendCompose()}});
  q("refresh").onclick=async()=>{if(q("refresh").disabled)return;q("refresh").disabled=true;q("refresh").style.transform="rotate(180deg)";try{await load({sync:false});toast("Inbox refreshed");api("/inbox/api/sync",{method:"POST",body:"{}"}).then(()=>load({sync:false})).catch(()=>{})}finally{setTimeout(()=>{q("refresh").disabled=false;q("refresh").style.transform=""},250)}};q("search").oninput=render;document.querySelectorAll(".filter[data-filter]").forEach(b=>b.onclick=()=>{state.filter=b.dataset.filter;q("failurePanel").classList.remove("show");document.querySelectorAll(".filter").forEach(x=>x.classList.toggle("active",x===b));render()});q("failuresBtn").onclick=toggleFailures;q("undoSend").onclick=cancelPendingSend;q("back").onclick=()=>app.classList.remove("open");q("reply").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();q("composer").requestSubmit()}});document.addEventListener("visibilitychange",()=>{if(!document.hidden&&state.selected)openThread(state.selected,{markRead:true})});connectLive();setInterval(()=>load(),60000);load({sync:true});
  </script></body></html>`;
}

async function telnyxApiRequest(path, init = {}) {
  if (!TELNYX_API_KEY) throw new Error("TELNYX_API_KEY is not configured");
  const response = await fetch(`https://api.telnyx.com/v2${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${TELNYX_API_KEY}`,
      ...(init.body ? { "content-type":"application/json" } : {}),
      ...(init.headers || {})
    },
    signal:AbortSignal.timeout(15000)
  });
  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw }; }
  if (!response.ok) throw new Error(`Telnyx ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function telnyxAccountInventory() {
  const [numbers, profiles] = await Promise.all([
    telnyxApiRequest("/phone_numbers?page[size]=100"),
    telnyxApiRequest("/messaging_profiles?page[size]=100")
  ]);
  return {
    numbers: (numbers?.data || []).map((row) => ({
      id: row.id,
      phone_number: row.phone_number,
      status: row.status || null,
      connection_id: row.connection_id || null,
      messaging_profile_id: row.messaging_profile_id || null,
      tags: row.tags || []
    })),
    messaging_profiles: (profiles?.data || []).map((row) => ({
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      webhook_url: row.webhook_url || null,
      webhook_api_version: row.webhook_api_version || null,
      whitelisted_destinations: row.whitelisted_destinations || []
    }))
  };
}

async function configureTelnyxMessagingProfile({ profileId = "", name = "Recover Revenue" } = {}) {
  const targetWebhook = telnyxWebhookTarget();
  if (!targetWebhook) throw new Error("Telnyx webhook target is not configured");
  const inventory = await telnyxAccountInventory();
  let profile = profileId
    ? inventory.messaging_profiles.find((row) => row.id === profileId)
    : inventory.messaging_profiles.find((row) => row.name === name) || (inventory.messaging_profiles.length === 1 ? inventory.messaging_profiles[0] : null);

  const payload = {
    name: profile?.name || name,
    enabled: true,
    webhook_url: targetWebhook,
    webhook_api_version: "2",
    whitelisted_destinations: ["US"]
  };

  if (profile?.id) {
    const updated = await telnyxApiRequest(`/messaging_profiles/${encodeURIComponent(profile.id)}`, {
      method:"PATCH",
      body:JSON.stringify(payload)
    });
    return { created:false, profile:updated?.data || updated };
  }

  const created = await telnyxApiRequest("/messaging_profiles", {
    method:"POST",
    body:JSON.stringify(payload)
  });
  return { created:true, profile:created?.data || created };
}

async function assignTelnyxNumberToProfile({ phoneNumberId, messagingProfileId }) {
  if (!phoneNumberId || !messagingProfileId) throw new Error("phoneNumberId and messagingProfileId are required");
  const updated = await telnyxApiRequest(`/phone_numbers/${encodeURIComponent(phoneNumberId)}`, {
    method:"PATCH",
    body:JSON.stringify({ messaging_profile_id: messagingProfileId })
  });
  return updated?.data || updated;
}

async function telnyxLookupSmsSuitability(phone, redis) {
  const normalized = normalizeE164(phone);
  if (!normalized) return { decision:"SKIP", line_type:"invalid", reason:"invalid_e164", cached:false };

  const cacheKey = `recover:sms:number-lookup:${normalized}`;
  const cachedRaw = await redis.get(cacheKey).catch(() => null);
  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw);
      const cachedType = String(cached?.line_type || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
      if (cached?.decision === "SEND" && ["mobile","wireless"].includes(cachedType)) {
        return { ...cached, cached:true };
      }
      return {
        ...cached,
        decision:"SKIP",
        reason:`cost_first_non_mobile_${cachedType || "unknown"}`,
        cached:true
      };
    } catch {}
  }

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const body = await telnyxApiRequest(`/number_lookup/${encodeURIComponent(normalized)}?type=carrier`);
      const data = body?.data || {};
      const carrier = data?.carrier || {};
      const rawType = String(carrier?.type || "").trim().toLowerCase();
      const type = rawType.replace(/[\s-]+/g, "_");
      const smsCapable = ["mobile","wireless"].includes(type);
      const decision = smsCapable ? "SEND" : "SKIP";
      const result = {
        decision,
        line_type: type || "unknown",
        carrier_name: String(carrier?.name || carrier?.carrier_name || "").trim() || null,
        reason: smsCapable
          ? "confirmed_mobile"
          : `cost_first_non_mobile_${type || "unknown"}`,
        checked_at: new Date().toISOString(),
        cached:false
      };
      await redis.set(cacheKey, JSON.stringify(result), { EX: 2592000 });
      return result;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500 * (2 ** attempt)));
    }
  }
  return {
    decision:"CHECK",
    line_type:"unknown",
    reason:"lookup_error",
    error:String(lastError?.message || lastError || "lookup_failed"),
    checked_at:new Date().toISOString(),
    cached:false
  };
}

async function telnyxSendMessage(to, text) {
  if (!TELNYX_API_KEY) throw new Error("TELNYX_API_KEY is not configured");
  if (!TELNYX_FROM_NUMBER) throw new Error("TELNYX_FROM_NUMBER is not configured");
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch("https://api.telnyx.com/v2/messages", {
        method:"POST",
        headers:{ authorization:`Bearer ${TELNYX_API_KEY}`, "content-type":"application/json" },
        body:JSON.stringify({ from:TELNYX_FROM_NUMBER, to, text }),
        signal:AbortSignal.timeout(15000)
      });
      const raw = await response.text();
      let body;
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw }; }
      if (response.ok) {
        const id = body?.data?.id || randomUUID();
        await saveInboxMessage({
          id,
          phone: to,
          direction: "outbound",
          text,
          status: body?.data?.to?.[0]?.status || "accepted",
          at: body?.data?.sent_at || new Date().toISOString(),
          raw: body?.data || null
        }).catch(error => console.error("Inbox outbound persistence error", error?.message || error));
        return body;
      }
      const error = new Error(`Telnyx ${response.status}: ${JSON.stringify(body)}`);
      error.status = response.status;
      if (response.status !== 429 && response.status < 500) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      const status = Number(error?.status || 0);
      const retryable = status === 429 || status >= 500 || /timeout|aborted|fetch failed/i.test(String(error?.message || error));
      if (!retryable) throw error;
    }
    if (attempt < 4) await new Promise(resolve => setTimeout(resolve, Math.min(10000, 500 * (2 ** attempt))));
  }
  throw lastError || new Error("Telnyx send failed");
}


async function sendOneTimeSmsProbe() {
  const testId = String(process.env.SMS_ONE_TIME_TEST_ID || "").trim();
  const phone = normalizeE164(process.env.SMS_ONE_TIME_TEST_PHONE || "");
  const message = String(process.env.SMS_ONE_TIME_TEST_TEXT || "").trim();
  if (!testId || !phone || !message || !ACQUISITION_REDIS_URL) return;

  const redis = await getAcquisitionRedis();
  const key = `recover:sms:one-time-test:${testId}`;
  if (await redis.get(key)) {
    console.log("One-time SMS probe already sent", { testId, phoneHint: `••••${phone.slice(-4)}` });
    return;
  }

  const response = await telnyxSendMessage(phone, message);
  const providerMessageId = response?.data?.id || null;
  await redis.set(key, JSON.stringify({
    test_id: testId,
    phone_hint: `••••${phone.slice(-4)}`,
    provider_message_id: providerMessageId,
    sent_at: new Date().toISOString()
  }), { EX: 2592000 });
  console.log("One-time SMS probe accepted", { testId, phoneHint: `••••${phone.slice(-4)}`, providerMessageId });
}


async function startConfiguredBulkSmsCampaign() {
  if (!SMS_BULK_AUTOSTART || !SMS_BULK_CAMPAIGN_ID) return { configured: false };
  if (SMS_BULK_PAUSED) return { configured:true, queued:false, paused:true, reason:"configured_pause" };
  if (!SMS_10DLC_APPROVED && !SMS_UNREGISTERED_SEND_OVERRIDE)
    return { configured:true, queued:false, paused:true, reason:"10dlc_not_approved" };
  if (!SMS_BULK_USER_CONFIRMED_CONSENT) throw new Error("SMS_BULK_USER_CONFIRMED_CONSENT must be true");
  if (!SMS_BULK_SPREADSHEET_ID || !SMS_BULK_TAB_NAME) throw new Error("Bulk SMS spreadsheet configuration is incomplete");
  if (!SMS_BULK_START_ROW || !SMS_BULK_END_ROW || SMS_BULK_END_ROW < SMS_BULK_START_ROW)
    throw new Error("Bulk SMS row range is invalid");
  const expectedCount = SMS_BULK_END_ROW - SMS_BULK_START_ROW + 1;
  if (expectedCount > SMS_MAX_BATCH_RECIPIENTS)
    throw new Error(`Bulk SMS range exceeds SMS_MAX_BATCH_RECIPIENTS (${SMS_MAX_BATCH_RECIPIENTS})`);

  const redis = await getAcquisitionRedis();
  const senderBlockRaw = await redis.get("recover:sms:sender-block:40010");
  const startBlockReason = bulkSmsBlockReason({
    configuredPause: SMS_BULK_PAUSED,
    registrationApproved: SMS_10DLC_APPROVED,
    carrierBlocked: Boolean(senderBlockRaw),
    unregisteredSendOverride: SMS_UNREGISTERED_SEND_OVERRIDE,
  });
  if (startBlockReason) return { configured:true, queued:false, paused:true, reason:startBlockReason };
  const campaignKey = `recover:sms:bulk-campaign:${SMS_BULK_CAMPAIGN_ID}`;
  const existingBatchId = await redis.get(campaignKey);
  if (existingBatchId) {
    const raw = await redis.get(`recover:sms:batch:${existingBatchId}`);
    if (raw) {
      const batch = JSON.parse(raw);
      if (["queued", "running"].includes(batch.status)) {
        await redis.lPush("recover:sms:queue", existingBatchId);
        console.log("Recovered bulk SMS campaign queue", {
          campaignId: SMS_BULK_CAMPAIGN_ID,
          batchId: existingBatchId,
          status: batch.status,
          processedCount: batch.processed_count || 0,
          acceptedCount: batch.accepted_count || 0
        });
      } else if (shouldResumePausedSmsBatch({ status:batch.status, blockReason:startBlockReason })) {
        batch.status = "queued";
        batch.updated_at = new Date().toISOString();
        delete batch.pause_reason;
        await redis.set(`recover:sms:batch:${existingBatchId}`, JSON.stringify(batch), { EX: 604800 });
        await redis.lPush("recover:sms:queue", existingBatchId);
        console.log("Resumed paused bulk SMS campaign", {
          campaignId: SMS_BULK_CAMPAIGN_ID,
          batchId: existingBatchId,
          processedCount: batch.processed_count || 0,
          sendIntervalMs: SMS_SEND_INTERVAL_MS,
        });
      } else {
        console.log("Bulk SMS campaign already finalized", {
          campaignId: SMS_BULK_CAMPAIGN_ID,
          batchId: existingBatchId,
          status: batch.status
        });
      }
      return {
        configured: true,
        existing: true,
        resumed: batch.status === "queued",
        batch_id: existingBatchId,
        status: batch.status,
      };
    }
  }

  const lockKey = `${campaignKey}:lock`;
  const locked = await redis.set(lockKey, process.pid.toString(), { NX: true, EX: 120 });
  if (!locked) return { configured: true, locked: true };

  try {
    const rows = await SMS_SHEET_BRIDGE.readBasicRows({
      spreadsheetId: SMS_BULK_SPREADSHEET_ID,
      tabName: SMS_BULK_TAB_NAME,
      startRow: SMS_BULK_START_ROW,
      endRow: SMS_BULK_END_ROW
    });
    if (rows.length !== expectedCount)
      throw new Error(`Bulk SMS sheet returned ${rows.length} rows; expected ${expectedCount}`);

    const seen = new Set();
    const recipients = rows.map((row) => {
      const phone = normalizeE164(row.phone);
      const message = String(row.message || "").trim();
      const link = String(row.link || "").trim();
      const businessName = String(row.business_name || "").trim();
      if (!phone) throw new Error(`Bulk SMS row ${row.row} has invalid phone`);
      if (seen.has(phone)) throw new Error(`Bulk SMS row ${row.row} duplicates phone ${phone}`);
      seen.add(phone);
      if (!message) throw new Error(`Bulk SMS row ${row.row} has empty message`);
      if (!link || !/^https:\/\//i.test(link)) throw new Error(`Bulk SMS row ${row.row} has invalid link`);
      if (!message.includes(link)) throw new Error(`Bulk SMS row ${row.row} message/link mismatch`);
      if (!businessName) throw new Error(`Bulk SMS row ${row.row} has empty business name`);
      return {
        phone,
        message,
        consent: true,
        contact_id: `sheet-row-${row.row}`,
        metadata: {
          campaign_id: SMS_BULK_CAMPAIGN_ID,
          sheet_spreadsheet_id: SMS_BULK_SPREADSHEET_ID,
          sheet_tab_name: SMS_BULK_TAB_NAME,
          sheet_row: row.row,
          business_name: businessName,
          link,
          consent_source: "user_confirmed_bulk_consent",
          consent_confirmed_at: new Date().toISOString()
        }
      };
    });

    const preview = await prepareSmsBatch({
      recipients,
      label: `Bulk SMS ${SMS_BULK_CAMPAIGN_ID} rows ${SMS_BULK_START_ROW}-${SMS_BULK_END_ROW}`
    });
    if (preview.accepted_count !== expectedCount || preview.invalid.length || preview.suppressed.length) {
      throw new Error(
        `Bulk SMS validation failed accepted=${preview.accepted_count} invalid=${preview.invalid.length} suppressed=${preview.suppressed.length}`
      );
    }
    const queued = await enqueuePreparedSmsBatch(preview.id, preview.confirmation_token);
    await redis.set(campaignKey, queued.id, { EX: 2592000 });
    console.log("Bulk SMS campaign queued", {
      campaignId: SMS_BULK_CAMPAIGN_ID,
      batchId: queued.id,
      startRow: SMS_BULK_START_ROW,
      endRow: SMS_BULK_END_ROW,
      acceptedCount: queued.accepted_count,
      estimatedSegments: queued.estimated_segments,
      sendIntervalMs: SMS_SEND_INTERVAL_MS
    });
    return { configured: true, queued: true, batch_id: queued.id, accepted_count: queued.accepted_count };
  } finally {
    await redis.del(lockKey).catch(() => null);
  }
}

async function startSmsWorker() {
  if (!ACQUISITION_REDIS_URL) return;
  const base = await getAcquisitionRedis();
  const redis = base.duplicate();
  redis.on("error", err => console.error("SMS worker Redis error", err));
  await redis.connect();
  console.log("Recover SMS worker loop started");

  while (true) {
    try {
      const item = await redis.brPop("recover:sms:queue", 5);
      const batchId = item?.element;
      if (!batchId) continue;
      const key = `recover:sms:batch:${batchId}`;
      const raw = await redis.get(key);
      if (!raw) continue;
      const batch = JSON.parse(raw);
      if (!["queued","running"].includes(batch.status)) continue;

      batch.status = "running";
      batch.started_at ||= new Date().toISOString();
      batch.sent_count ||= 0;
      batch.failed_count ||= 0;
      batch.processed_count ||= 0;
      const save = () => redis.set(key, JSON.stringify(batch), { EX: 604800 });
      await save();

      const recipients = Array.isArray(batch.recipients) ? batch.recipients : [];
      for (let i = batch.processed_count; i < recipients.length; i++) {
        const recipient = recipients[i];

        if (recipient?.metadata?.campaign_id) {
          const senderBlockRaw = await redis.get("recover:sms:sender-block:40010");
          const blockReason = bulkSmsBlockReason({
            configuredPause: SMS_BULK_PAUSED,
            registrationApproved: SMS_10DLC_APPROVED,
            carrierBlocked: Boolean(senderBlockRaw),
            unregisteredSendOverride: SMS_UNREGISTERED_SEND_OVERRIDE,
          });
          if (blockReason) {
            batch.status = "paused";
            batch.updated_at = new Date().toISOString();
            batch.pause_reason = blockReason;
            await save();
            await SMS_SHEET_BRIDGE.writeBasicReachability("CHECK", recipient.metadata || {}, blockReason)
              .catch(error => console.error("SMS sender-block sheet writeback error", error.message));
            console.error("Bulk SMS halted by sender safety gate", {
              batchId,
              sheetRow:recipient?.metadata?.sheet_row || null,
              reason:blockReason,
            });
            break;
          }
          if (SMS_UNREGISTERED_SEND_OVERRIDE) {
            const delivery = await inboxFailureBreakdown();
            const stopReason = bulkSmsOverrideStopReason({
              overrideEnabled: true,
              outboundMessages: delivery.outbound_messages,
              failureRatePercent: delivery.failure_rate_percent,
              cutoffPercent: SMS_OVERRIDE_FAILURE_CUTOFF_PERCENT,
            });
            if (stopReason) {
              batch.status = "paused";
              batch.updated_at = new Date().toISOString();
              batch.pause_reason = stopReason;
              await save();
              console.error("Bulk SMS halted by delivery failure cutoff", {
                batchId,
                failureRatePercent: delivery.failure_rate_percent,
                cutoffPercent: SMS_OVERRIDE_FAILURE_CUTOFF_PERCENT,
              });
              break;
            }
          }
        }

        const suppressed = await redis.sIsMember("recover:sms:suppressed", recipient.phone);
        if (suppressed) {
          if (recipient?.metadata?.campaign_id) {
            await SMS_SHEET_BRIDGE.writeBasicReachability("SKIP", recipient.metadata || {}, "suppressed")
              .catch(error => console.error("SMS reachability suppression writeback error", error.message));
          }
          const result = {
            batch_id:batchId,
            index:i,
            phone:recipient.phone,
            contact_id:recipient.contact_id || "",
            status:"skipped_suppressed",
            at:new Date().toISOString()
          };
          await redis.rPush(`recover:sms:batch:${batchId}:results`, JSON.stringify(result));
          if (shouldPostSmsResultCallback(recipient?.metadata)) {
            await postSmsResultCallback(result).catch(error => console.error("SMS callback error", error.message));
          }
          if (recipient?.metadata?.campaign_id) {
            await SMS_SHEET_BRIDGE.writeBasicSendResult(result, recipient.metadata || {}).catch(error => console.error("SMS basic sheet suppression writeback error", error.message));
          } else {
            await SMS_SHEET_BRIDGE.writeSendResult(result, recipient.metadata || {}).catch(error => console.error("SMS sheet suppression writeback error", error.message));
          }
          batch.processed_count = i + 1;
          await save();
          continue;
        }

        if (recipient?.metadata?.campaign_id) {
          await SMS_SHEET_BRIDGE.writeBasicReachability("CHECK", recipient.metadata || {}, "lookup_pending")
            .catch(error => console.error("SMS reachability CHECK writeback error", error.message));

          const lookup = await telnyxLookupSmsSuitability(recipient.phone, redis);
          if (lookup.decision !== "SEND") {
            const reachability = reachabilityForLookupDecision(lookup.decision);
            await SMS_SHEET_BRIDGE.writeBasicReachability(reachability, recipient.metadata || {}, lookup.reason || lookup.line_type || "")
              .catch(error => console.error("SMS reachability decision writeback error", error.message));

            if (lookup.decision === "SKIP") {
              await redis.sAdd("recover:sms:suppressed", recipient.phone);
              await redis.hSet("recover:sms:suppression:reasons", recipient.phone, JSON.stringify({
                reason:"telnyx_lookup_not_sms_capable",
                line_type:lookup.line_type || "unknown",
                carrier_name:lookup.carrier_name || null,
                checked_at:lookup.checked_at || new Date().toISOString(),
                sheet_row:recipient?.metadata?.sheet_row || null
              }));
            } else {
              await redis.sAdd("recover:sms:lookup-pending", recipient.phone);
              await redis.hSet("recover:sms:lookup-pending-meta", recipient.phone, JSON.stringify({
                sheet_row:recipient?.metadata?.sheet_row || null,
                business_name:recipient?.metadata?.business_name || null,
                line_type:lookup.line_type || "unknown",
                reason:lookup.reason || "ambiguous_lookup",
                checked_at:lookup.checked_at || new Date().toISOString()
              }));
            }

            const result = {
              batch_id:batchId,
              index:i,
              phone:recipient.phone,
              contact_id:recipient.contact_id || "",
              status:lookup.decision === "SKIP" ? "skipped_lookup" : "lookup_check",
              error:lookup.error || lookup.reason || "",
              at:new Date().toISOString()
            };
            await redis.rPush(`recover:sms:batch:${batchId}:results`, JSON.stringify(result));
            batch.processed_count = i + 1;
            batch.updated_at = new Date().toISOString();
            batch.skipped_count = Number(batch.skipped_count || 0) + 1;
            await save();
            console.log(lookup.decision === "SKIP" ? "SMS lookup gate skipped send" : "SMS lookup gate held for review", {
              batchId,
              sheetRow:recipient?.metadata?.sheet_row || null,
              phoneHint:`••••${recipient.phone.slice(-4)}`,
              decision:lookup.decision,
              lineType:lookup.line_type || "unknown",
              cached:Boolean(lookup.cached)
            });
            continue;
          }

          await SMS_SHEET_BRIDGE.writeBasicReachability("SEND", recipient.metadata || {}, lookup.line_type || "mobile")
            .catch(error => console.error("SMS reachability SEND writeback error", error.message));
          console.log("SMS lookup gate approved send", {
            batchId,
            sheetRow:recipient?.metadata?.sheet_row || null,
            phoneHint:`••••${recipient.phone.slice(-4)}`,
            lineType:lookup.line_type || "mobile",
            cached:Boolean(lookup.cached)
          });
        }

        for (let j = 0; j < recipient.messages.length; j++) {
          const sendAttemptKey = `recover:sms:send-attempt:${batchId}:${i}:${j}`;
          const priorRaw = await redis.get(sendAttemptKey);
          if (priorRaw) {
            let prior = {};
            try { prior = JSON.parse(priorRaw); } catch {}
            console.log("SMS duplicate prevented", {
              batchId,
              sheetRow: recipient?.metadata?.sheet_row || null,
              phoneHint: `••••${recipient.phone.slice(-4)}`,
              priorStatus: prior.status || "attempted",
              providerMessageId: prior.provider_message_id || null
            });
            if (prior.status === "accepted") {
              const replayResult = {
                batch_id: batchId,
                index: i,
                message_index: j,
                phone: recipient.phone,
                contact_id: recipient.contact_id || "",
                status: "accepted",
                telnyx_message_id: prior.provider_message_id || null,
                at: prior.at || new Date().toISOString()
              };
              if (recipient?.metadata?.campaign_id) {
                await SMS_SHEET_BRIDGE.writeBasicSendResult(replayResult, recipient.metadata || {}).catch(error => console.error("SMS basic sheet replay writeback error", error.message));
              }
            }
            continue;
          }

          const attempt = {
            status: "attempting",
            sheet_row: recipient?.metadata?.sheet_row || null,
            phone_hint: `••••${recipient.phone.slice(-4)}`,
            at: new Date().toISOString()
          };
          const claimed = await redis.set(sendAttemptKey, JSON.stringify(attempt), { NX: true, EX: 2592000 });
          if (!claimed) continue;

          try {
            const outboundText = String(recipient.messages[j] || "");
            const response = await telnyxSendMessage(recipient.phone, outboundText);
            await saveInboxContactProfile(recipient.phone, recipient.metadata || {}).catch(error =>
              console.error("Inbox contact profile persistence error", error?.message || error)
            );
            const result = {
              batch_id:batchId,
              index:i,
              message_index:j,
              phone:recipient.phone,
              contact_id:recipient.contact_id || "",
              status:"accepted",
              telnyx_message_id:response?.data?.id || null,
              at:new Date().toISOString()
            };
            await redis.set(sendAttemptKey, JSON.stringify({
              status: "accepted",
              provider_message_id: result.telnyx_message_id,
              at: result.at
            }), { EX: 2592000 });
            await redis.rPush(`recover:sms:batch:${batchId}:results`, JSON.stringify(result));
            if (shouldPostSmsResultCallback(recipient?.metadata)) {
              await postSmsResultCallback(result).catch(error => console.error("SMS callback error", error.message));
            }
            if (recipient?.metadata?.campaign_id) {
              await SMS_SHEET_BRIDGE.writeBasicSendResult(result, recipient.metadata || {}).catch(error => console.error("SMS basic sheet send writeback error", error.message));
            } else {
              await SMS_SHEET_BRIDGE.writeSendResult(result, recipient.metadata || {}).catch(error => console.error("SMS sheet send writeback error", error.message));
            }
            console.log("SMS accepted", {
              batchId,
              sheetRow: recipient?.metadata?.sheet_row || null,
              phoneHint: `••••${recipient.phone.slice(-4)}`,
              providerMessageId: result.telnyx_message_id,
              estimatedSegments: smsSegmentEstimate(outboundText)
            });
            batch.sent_count += 1;
          } catch (error) {
            batch.failed_count += 1;
            const result = {
              batch_id:batchId,
              index:i,
              message_index:j,
              phone:recipient.phone,
              contact_id:recipient.contact_id || "",
              status:"failed",
              error:error?.message || "send_failed",
              at:new Date().toISOString()
            };
            await redis.set(sendAttemptKey, JSON.stringify({
              status: "failed",
              error: result.error,
              at: result.at
            }), { EX: 2592000 });
            await redis.rPush(`recover:sms:batch:${batchId}:results`, JSON.stringify(result));
            if (shouldPostSmsResultCallback(recipient?.metadata)) {
              await postSmsResultCallback(result).catch(callbackError => console.error("SMS callback error", callbackError.message));
            }
            if (recipient?.metadata?.campaign_id) {
              await SMS_SHEET_BRIDGE.writeBasicSendResult(result, recipient.metadata || {}).catch(sheetError => console.error("SMS basic sheet failure writeback error", sheetError.message));
            } else {
              await SMS_SHEET_BRIDGE.writeSendResult(result, recipient.metadata || {}).catch(sheetError => console.error("SMS sheet send writeback error", sheetError.message));
            }
            console.error("SMS failed", {
              batchId,
              sheetRow: recipient?.metadata?.sheet_row || null,
              phoneHint: `••••${recipient.phone.slice(-4)}`,
              error: result.error
            });
          }
          await new Promise(resolve => setTimeout(resolve, SMS_SEND_INTERVAL_MS));
        }
        batch.processed_count = i + 1;
        batch.updated_at = new Date().toISOString();
        await save();
      }

      if (batch.status === "paused") continue;

      batch.status = batch.failed_count > 0 ? "completed_with_errors" : "completed";
      batch.completed_at = new Date().toISOString();
      await save();
    } catch (error) {
      console.error("SMS worker loop error", error);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

const handler = createMcpHandler(buildServer);
const nodeHandler = toNodeHandler(handler);


if (TELNYX_AUTO_CONFIGURE_PROFILE) {
  void configureTelnyxMessagingProfile({ name: "Recover Revenue" })
    .then(result => console.log("Telnyx messaging profile webhook configured", { created: result?.created, profile_id: result?.profile?.id || null, webhook_url: telnyxWebhookTarget() }))
    .catch(error => console.error("Telnyx messaging profile auto-configure failed", error?.message || error));
}

void sendOneTimeSmsProbe().catch(error => console.error("One-time SMS probe error", error?.message || error));
void startSmsWorker().catch(error => console.error("SMS worker startup error", error));
setTimeout(() => {
  void backfillInboxFromSmsBatches({ maxBatches: 300 })
    .then(async result => {
      const replies = await rebuildInboxReplyIndex();
      console.log("Recover inbox history backfill complete", { ...result, ...replies });
    })
    .catch(error => console.error("Recover inbox history backfill error", error?.message || error));
}, 5000);
setTimeout(() => {
  void reconcileAmbiguousLookupSuppressions({ limit: 5000 })
    .then(result => console.log("Recover ambiguous lookup suppression reconciliation complete", result))
    .catch(error => console.error("Recover ambiguous lookup suppression reconciliation error", error?.message || error));
}, 11000);

setTimeout(() => {
  void backfillSmsSender10dlcBlock({ limit: 5000 })
    .then(result => console.log("Recover sender 10DLC block backfill complete", result))
    .catch(error => console.error("Recover sender 10DLC block backfill error", error?.message || error));
}, 7000);



setTimeout(() => {
  void backfillNonRoutableSmsSuppressions({ limit: 5000 })
    .then(result => console.log("Recover non-routable SMS suppression backfill complete", result))
    .catch(error => console.error("Recover non-routable SMS suppression backfill error", error?.message || error));
}, 9000);

setTimeout(() => {
  void logInboxDeliveryFailureDiagnostics({ limit: 100 })
    .then(result => console.log("Recover inbox failure diagnostics complete", result))
    .catch(error => console.error("Recover inbox failure diagnostics error", error?.message || error));
}, 12000);

setTimeout(() => {
  void repairBackfilledInboxBodiesFromTelnyx({ limit: 500 })
    .then(result => console.log("Recover inbox Telnyx body repair complete", result))
    .catch(error => console.error("Recover inbox Telnyx body repair error", error?.message || error));
}, 8000);
setTimeout(() => {
  void startConfiguredBulkSmsCampaign().catch(error =>
    console.error("Bulk SMS campaign startup error", error?.message || error)
  );
}, 10000);

startQualifiedGoogleSheetSync({
  getRedis: getAcquisitionRedis,
  getQualifiedLeads: getQualifiedSheetLeads,
  enabled: GOOGLE_SHEETS_SYNC_ENABLED,
  intervalMs: GOOGLE_SHEETS_SYNC_INTERVAL_MS,
  capacity: GOOGLE_SHEETS_TAB_CAPACITY,
  targetsJson: GOOGLE_SHEETS_TARGETS_JSON,
  serviceAccountJson: GOOGLE_SERVICE_ACCOUNT_JSON,
});

const httpServer = createHttpServer((req, res) => {
  const requestUrl = new URL(req.url || "/", OAUTH_ISSUER || `http://${req.headers.host || "localhost"}`);
  if (oauthEnabled && req.method === "GET" && ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"].includes(requestUrl.pathname)) {
    res.writeHead(200, {"content-type":"application/json", "cache-control":"public, max-age=300"});
    res.end(JSON.stringify(oauthMetadata()));
    return;
  }
  if (oauthEnabled && req.method === "GET" && ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp", "/mcp/.well-known/oauth-protected-resource"].includes(requestUrl.pathname)) {
    res.writeHead(200, {"content-type":"application/json", "cache-control":"public, max-age=300"});
    res.end(JSON.stringify(protectedResourceMetadata()));
    return;
  }
  if (oauthEnabled && requestUrl.pathname === "/oauth/authorize" && ["GET", "POST"].includes(req.method || "")) {
    void handleOauthAuthorize(req, res, requestUrl).catch(() => oauthError(res, 400, "invalid_request", "Unable to process authorization request."));
    return;
  }
  if (oauthEnabled && requestUrl.pathname === "/oauth/token" && req.method === "POST") {
    void handleOauthToken(req, res).catch(() => oauthError(res, 400, "invalid_request", "Unable to process token request."));
    return;
  }



  if (requestUrl.pathname === "/inbox/events" && req.method === "GET") {
    if (!inboxAuthorized(req)) {
      res.writeHead(401, {"content-type":"application/json"});
      res.end(JSON.stringify({error:"unauthorized"}));
      return;
    }
    res.writeHead(200, {
      "content-type":"text/event-stream",
      "cache-control":"no-cache, no-transform",
      "connection":"keep-alive",
      "x-accel-buffering":"no"
    });
    res.write(`data: ${JSON.stringify({type:"connected",at:new Date().toISOString()})}\n\n`);
    INBOX_SSE_CLIENTS.add(res);
    const keepAlive = setInterval(() => {
      try { res.write(": keepalive\n\n"); } catch {}
    }, 20000);
    req.on("close", () => {
      clearInterval(keepAlive);
      INBOX_SSE_CLIENTS.delete(res);
    });
    return;
  }

  if (requestUrl.pathname === "/inbox/unavailable" && req.method === "GET") {
    void (async () => {
      if (!inboxAuthorized(req)) { res.writeHead(401,{"content-type":"application/json"});res.end(JSON.stringify({error:"unauthorized"}));return; }
      const data = await listUnavailableSmsNumbers({ limit: 1000 });
      res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});
      res.end(JSON.stringify({ok:true,...data}));
    })().catch(error=>{res.writeHead(500,{"content-type":"application/json"});res.end(JSON.stringify({ok:false,error:error?.message||"unavailable_list_failed"}));});
    return;
  }

  if (requestUrl.pathname === "/inbox/failures" && req.method === "GET") {
    void (async () => {
      if (!inboxAuthorized(req)) { res.writeHead(401,{"content-type":"application/json"});res.end(JSON.stringify({error:"unauthorized"}));return; }
      const data = await inboxFailureBreakdown();
      res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});
      res.end(JSON.stringify({ok:true,...data}));
    })().catch(error=>{res.writeHead(500,{"content-type":"application/json"});res.end(JSON.stringify({ok:false,error:error?.message||"failure_breakdown_failed"}));});
    return;
  }

  if (requestUrl.pathname === "/inbox/status" && req.method === "GET") {
    void (async () => {
      const redis = await getAcquisitionRedis();
      const threadCount = await redis.zCard("recover:sms:inbox:threads");
      const messageCount = await redis.hLen("recover:sms:inbox:messages");
      const suppressedCount = await redis.sCard("recover:sms:suppressed");
      const failureBreakdown = await inboxFailureBreakdown();
      const unavailable = await listUnavailableSmsNumbers({ limit: 1000 });
      const replyThreads = await redis.zCard("recover:sms:inbox:reply-threads");
      const replyPhones = await redis.zRange("recover:sms:inbox:reply-threads", 0, -1);
      let unreadReplies = 0;
      for (const phone of replyPhones || []) {
        const latestInbound = Number(await redis.zScore("recover:sms:inbox:reply-threads", phone) || 0);
        const readScore = Number(await redis.hGet("recover:sms:inbox:read", phone) || 0);
        if (latestInbound > readScore) unreadReplies++;
      }
      const allMessages = await redis.hVals("recover:sms:inbox:messages");
      let inboundMessages = 0;
      for (const raw of allMessages || []) {
        try {
          const message = JSON.parse(raw);
          if (message?.direction === "inbound") inboundMessages++;
        } catch {}
      }
      const outboundMessages = failureBreakdown.outbound_messages;
      const submittedMessages = failureBreakdown.submitted_messages;
      const sentMessages = failureBreakdown.sent_messages;
      const deliveredMessages = failureBreakdown.delivered_messages;
      const failedMessages = failureBreakdown.failed_messages;
      const failureRate = failureBreakdown.failure_rate_percent;
      res.writeHead(200, {"content-type":"application/json","cache-control":"no-store"});
      res.end(JSON.stringify({
        ok:true,
        service:"recover-scrape-mcp",
        inbox_configured:Boolean(INBOX_ACCESS_PASSWORD && MCP_AUTH_TOKEN),
        telnyx_configured:Boolean(TELNYX_API_KEY && TELNYX_FROM_NUMBER),
        webhook_target_configured:Boolean(telnyxWebhookTarget()),
        threads:threadCount,
        messages:messageCount,
        reply_threads:replyThreads,
        unread_replies:unreadReplies,
        inbound_messages:inboundMessages,
        outbound_messages:outboundMessages,
        submitted_messages:submittedMessages,
        sent_messages:sentMessages,
        delivered_messages:deliveredMessages,
        failed_messages:failedMessages,
        failure_rate_percent:failureRate,
        live_clients:INBOX_SSE_CLIENTS.size,
        non_routable_unavailable:unavailable.count,
        failure_reasons:(failureBreakdown.reasons || []).slice(0,12),
        suppressed:suppressedCount
      }));
    })().catch(error => {
      res.writeHead(500, {"content-type":"application/json","cache-control":"no-store"});
      res.end(JSON.stringify({ok:false,error:error?.message||"inbox_status_failed"}));
    });
    return;
  }

  if (requestUrl.pathname === "/inbox" && req.method === "GET") {
    res.writeHead(200, {"content-type":"text/html; charset=utf-8","cache-control":"no-store","x-frame-options":"DENY"});
    res.end(inboxAuthorized(req) ? inboxAppHtml() : inboxLoginHtml());
    return;
  }

  if (requestUrl.pathname === "/inbox/login" && req.method === "POST") {
    void (async () => {
      if (!INBOX_ACCESS_PASSWORD || !MCP_AUTH_TOKEN) {
        res.writeHead(503, {"content-type":"text/html; charset=utf-8"});
        res.end(inboxLoginHtml("Inbox login is not configured."));
        return;
      }
      const form = await readForm(req);
      if (!secureEqual(form.get("password") || "", INBOX_ACCESS_PASSWORD)) {
        res.writeHead(401, {"content-type":"text/html; charset=utf-8"});
        res.end(inboxLoginHtml("Wrong password."));
        return;
      }
      res.writeHead(303,{location:"/inbox","set-cookie":`recover_inbox=${encodeURIComponent(inboxSessionToken())}; Path=/inbox; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`});
      res.end();
    })().catch(error => {
      res.writeHead(422, {"content-type":"text/html; charset=utf-8"});
      res.end(inboxLoginHtml(error?.message || "Login failed"));
    });
    return;
  }

  if (requestUrl.pathname === "/inbox/logout" && req.method === "POST") {
    res.writeHead(303,{location:"/inbox","set-cookie":"recover_inbox=; Path=/inbox; HttpOnly; Secure; SameSite=Lax; Max-Age=0"});res.end();return;
  }

  if (requestUrl.pathname === "/inbox/api/threads" && req.method === "GET") {
    void (async () => {
      if (!inboxAuthorized(req)) { res.writeHead(401,{"content-type":"application/json"});res.end(JSON.stringify({error:"unauthorized"}));return; }
      const threads=await listInboxThreads(2000);
      res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify({threads}));
    })().catch(error=>{res.writeHead(500,{"content-type":"application/json"});res.end(JSON.stringify({error:error?.message||"thread_list_failed"}));});
    return;
  }

  if (requestUrl.pathname === "/inbox/api/thread" && req.method === "GET") {
    void (async () => {
      if (!inboxAuthorized(req)) { res.writeHead(401,{"content-type":"application/json"});res.end(JSON.stringify({error:"unauthorized"}));return; }
      const phone=requestUrl.searchParams.get("phone")||"";
      const data=await readInboxThread(phone,400);
      res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify(data));
    })().catch(error=>{res.writeHead(500,{"content-type":"application/json"});res.end(JSON.stringify({error:error?.message||"thread_read_failed"}));});
    return;
  }

  if (requestUrl.pathname === "/inbox/api/read" && req.method === "POST") {
    void (async () => {
      if (!inboxAuthorized(req)) { res.writeHead(401,{"content-type":"application/json"});res.end(JSON.stringify({error:"unauthorized"}));return; }
      const input = JSON.parse(await readRawBody(req, 16384) || "{}");
      const result = await markInboxThreadRead(String(input.phone || ""));
      res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});
      res.end(JSON.stringify({ok:true,...result}));
    })().catch(error=>{res.writeHead(422,{"content-type":"application/json"});res.end(JSON.stringify({error:error?.message||"mark_read_failed"}));});
    return;
  }

  if (requestUrl.pathname === "/inbox/api/sync" && req.method === "POST") {
    void (async () => {
      if (!inboxAuthorized(req)) { res.writeHead(401,{"content-type":"application/json"});res.end(JSON.stringify({error:"unauthorized"}));return; }
      const result = await backfillInboxFromSmsBatches({ maxBatches: 300 });
      const replies = await rebuildInboxReplyIndex();
      res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});
      res.end(JSON.stringify({ok:true,...result,...replies}));
    })().catch(error=>{res.writeHead(500,{"content-type":"application/json"});res.end(JSON.stringify({error:error?.message||"inbox_sync_failed"}));});
    return;
  }

  if (requestUrl.pathname === "/inbox/api/reply" && req.method === "POST") {
    void (async () => {
      if (!inboxAuthorized(req)) { res.writeHead(401,{"content-type":"application/json"});res.end(JSON.stringify({error:"unauthorized"}));return; }
      const input=JSON.parse(await readRawBody(req,65536)||"{}");
      const phone=normalizeInboxPhone(input.phone);
      const text=String(input.text||"").trim();
      if(!phone||!text||text.length>1600) throw new Error("invalid_reply");
      const redis=await getAcquisitionRedis();
      const senderBlockRaw=await redis.get("recover:sms:sender-block:40010");
      const blockReason=bulkSmsBlockReason({configuredPause:SMS_BULK_PAUSED,registrationApproved:SMS_10DLC_APPROVED,carrierBlocked:Boolean(senderBlockRaw),unregisteredSendOverride:SMS_UNREGISTERED_SEND_OVERRIDE});
      if(blockReason) throw new Error(`sms_sender_blocked:${blockReason}`);
      if(await redis.sIsMember("recover:sms:suppressed",phone)) throw new Error("recipient_is_suppressed");
      const sent=await telnyxSendMessage(phone,text);
      res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({ok:true,id:sent?.data?.id||null}));
    })().catch(error=>{res.writeHead(422,{"content-type":"application/json"});res.end(JSON.stringify({error:error?.message||"reply_failed"}));});
    return;
  }

  if (requestUrl.pathname === "/webhooks/telnyx" && req.method === "POST") {
    void (async () => {
      const expected=inboxWebhookToken();
      const supplied=requestUrl.searchParams.get("token")||"";
      if (!expected || !secureEqual(supplied,expected)) {
        res.writeHead(401,{"content-type":"application/json"});res.end(JSON.stringify({error:"invalid_webhook_token"}));return;
      }
      const raw=await readRawBody(req);
      const event=JSON.parse(raw||"{}");
      const data=event?.data||{};
      const payload=data?.payload||{};
      const type=String(data?.event_type||"");
      const messageId=String(payload?.id||"");
      if(type==="message.received"){
        const from=normalizeInboxPhone(payload?.from?.phone_number||payload?.from);
        const text=String(payload?.text||"");
        await saveInboxMessage({id:messageId||data.id,phone:from,direction:"inbound",text,status:"received",at:data?.occurred_at||payload?.received_at||new Date().toISOString(),raw:event});
        if(/^(stop|stopall|unsubscribe|cancel|end|quit)$/i.test(text.trim())){
          const redis=await getAcquisitionRedis();
          await redis.sAdd("recover:sms:suppressed",from);
          await redis.hSet("recover:sms:suppression:reasons",from,JSON.stringify({reason:"recipient_opt_out",at:new Date().toISOString(),source:"telnyx_webhook"}));
        }
      } else if(messageId && /^message\./.test(type)) {
        const status=String(payload?.to?.[0]?.status||payload?.status||type.replace(/^message\./,""));
        const updatedMessage = await updateInboxMessageStatus(messageId,status,event);
        const errorCodes = (Array.isArray(payload?.errors) ? payload.errors : []).map(e => String(e?.code || ""));
        if (errorCodes.includes("40001")) {
          await quarantineNonRoutableSms({ messageId, message:updatedMessage, event });
        }
        if (isCarrierRegistrationError(errorCodes)) {
          await blockSmsSenderFor10dlc({ messageId, event });
        }
        if (/(fail|reject|undeliver|expired|blocked)/i.test(status)) {
          const errors = Array.isArray(payload?.errors) ? payload.errors : [];
          console.log("SMS delivery failure webhook", {
            messageId,
            status,
            toStatus: payload?.to?.[0]?.status || null,
            errors: errors.map(e => ({ code:e?.code||null, title:e?.title||null, detail:e?.detail||null }))
          });
        }
      }
      res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({ok:true}));
    })().catch(error=>{console.error("Telnyx inbox webhook error",error);if(!res.headersSent){res.writeHead(422,{"content-type":"application/json"});res.end(JSON.stringify({error:error?.message||"webhook_failed"}));}});
    return;
  }

  if (requestUrl.pathname === "/stats/qualified-leads" && req.method === "GET") {
    void (async () => {
      try {
        const redis = await getAcquisitionRedis();
        const values = await redis.hVals("recover:leadstore:qualified");
        let parsed=0, noWebsite=0, contactable=0, noWebsiteContactable=0, coreNoWebsiteContactable=0, withWebsite=0;
        const placeIds=new Set(), phones=new Set();
        let duplicatePlaceIds=0, duplicatePhones=0;
        for (const value of values) {
          let lead; try { lead=JSON.parse(value); } catch { continue; }
          if (!lead) continue;
          parsed++;
          const website=String(lead.website||"").trim();
          const emails=Array.isArray(lead.emails) ? lead.emails : String(lead.email||lead.emails||"").split(/[;,\s]+/).filter(Boolean);
          const phone=String(lead.phone||"").trim();
          const hasContact=Boolean(phone)||emails.length>0;
          const nw=!website;
          if(nw) noWebsite++; else withWebsite++;
          if(hasContact) contactable++;
          if(nw&&hasContact) noWebsiteContactable++;
          if(nw&&hasContact&&isCoreHomeServiceLead(lead)) coreNoWebsiteContactable++;
          const place=String(lead.place_id||"").trim();
          if(place){ if(placeIds.has(place)) duplicatePlaceIds++; else placeIds.add(place); }
          const normalizedPhone=normalizePhone(phone);
          if(normalizedPhone){ if(phones.has(normalizedPhone)) duplicatePhones++; else phones.add(normalizedPhone); }
        }
        res.writeHead(200, {"content-type":"application/json","cache-control":"no-store"});
        res.end(JSON.stringify({
          redis_hash_entries: values.length,
          parsed,
          no_website:noWebsite,
          with_website:withWebsite,
          contactable,
          no_website_contactable:noWebsiteContactable,
          core_home_service_no_website_contactable:coreNoWebsiteContactable,
          duplicate_place_id_rows:duplicatePlaceIds,
          duplicate_phone_rows:duplicatePhones
        }));
      } catch (error) {
        res.writeHead(500, {"content-type":"application/json","cache-control":"no-store"});
        res.end(JSON.stringify({error:"qualified_stats_failed",message:error?.message||"unknown"}));
      }
    })();
    return;
  }

  if (requestUrl.pathname === "/exports/legacy-raw-recovery.csv" && req.method === "GET") {
    void (async () => {
      try {
        const redis = await getAcquisitionRedis();
        const jobs = [
          ["Brooklyn","b7a7858d-32a6-46c9-823c-0e477f938955",198],
          ["Bronx","99126613-c5ad-49c7-9fa5-1e92fd70e14b",116],
          ["Long Island","0861b272-d805-4af2-a084-71169153c7f8",154],
          ["Westchester","b28d3596-e31f-47ce-8342-040c3895ad67",119],
          ["Buffalo","df431879-e411-4536-bf87-a154ec180e84",90]
        ];
        const esc = value => '"' + String(value ?? "").replace(/"/g,'""') + '"';
        const header = ["Area","Business Name","Category","Address","Phone","Email","Website","Place ID","Review Count","Rating","Old Acquisition ID","Old UI Qualified Count","Old Status","No Website?","Contactable?","Campaign Eligible Now?","Legacy Note","Source"];
        const lines=[header.map(esc).join(",")];
        for (const [area,id,oldQualified] of jobs) {
          const jobRaw = await redis.get(`recover:acq:${id}`);
          if (!jobRaw) continue;
          const job = JSON.parse(jobRaw);
          const rawRows = await redis.lRange(`recover:acq:${id}:raw`,0,-1);
          for (const raw of rawRows) {
            let lead; try { lead = JSON.parse(raw); } catch { continue; }
            const emails = Array.isArray(lead.emails) ? lead.emails : String(lead.email||lead.emails||"").split(/[;,\s]+/).filter(Boolean);
            const noWebsite = !String(lead.website||"").trim();
            const contactable = !!String(lead.phone||"").trim() || emails.length>0;
            lines.push([
              area,lead.name||lead.title||"",lead.category||lead.industry||"",lead.address||"",lead.phone||"",emails.join(", "),lead.website||"",lead.place_id||"",
              lead.review_count||lead.reviews||0,lead.review_rating||lead.rating||0,id,oldQualified,job.status||"",
              noWebsite?"YES":"NO",contactable?"YES":"NO",(noWebsite&&contactable)?"YES":"NO",
              "Old UI qualified counter used score threshold and did not enforce no-website-only",
              `recover:acq:${id}:raw`
            ].map(esc).join(","));
          }
        }
        res.writeHead(200, {"content-type":"text/csv; charset=utf-8","cache-control":"no-store, max-age=0","access-control-allow-origin":"*"});
        res.end(lines.join("\n"));
      } catch (error) {
        res.writeHead(500, {"content-type":"application/json"});
        res.end(JSON.stringify({error:"legacy_export_failed",message:error?.message||"unknown"}));
      }
    })();
    return;
  }
  if (requestUrl.pathname === "/exports/us-hvac-no-website.csv" && req.method === "GET") {
    void (async () => {
      try {
        const redis = await getAcquisitionRedis();
        // Export from the permanent qualified lead store, not one campaign-scope set.
        // The campaign scope can omit valid leads discovered by other nationwide passes.
        const values = await redis.hVals("recover:leadstore:qualified");
        const leads = values
          .map(v => { try { return v ? JSON.parse(v) : null; } catch { return null; } })
          .filter(Boolean)
          .filter(lead => {
            const noWebsite = !String(lead.website||"").trim();
            const emails = Array.isArray(lead.emails) ? lead.emails : String(lead.email||lead.emails||"").split(/[;,\s]+/).filter(Boolean);
            const contactable = !!String(lead.phone||"").trim() || emails.length>0;
            return noWebsite && contactable && isCoreHomeServiceLead(lead);
          })
          .sort((a,b)=>String(a.acquisition_location||a.address||"").localeCompare(String(b.acquisition_location||b.address||"")) || String(a.name||"").localeCompare(String(b.name||"")));

        const esc = value => {
          const text = Array.isArray(value) ? value.join(", ") : String(value ?? "");
          return '"' + text.replace(/"/g,'""') + '"';
        };
        const header = ["Business Name","Category","Address","City","Region","Phone","Email","Website","Google Maps URL","Place ID","Review Count","Rating","Qualification Score","Acquisition Location","Acquisition ID","Status"];
        const lines=[header.map(esc).join(",")];
        for(const lead of leads){
          lines.push([
            lead.name||"",lead.category||"",lead.address||"",lead.city||"",lead.region||"",lead.phone||"",
            lead.emails||lead.email||"",lead.website||"",lead.google_maps_url||"",lead.place_id||"",
            lead.review_count||0,lead.review_rating||lead.rating||0,lead.qualification?.score||0,
            lead.acquisition_location||"",lead.acquisition_id||"","auto"
          ].map(esc).join(","));
        }
        res.writeHead(200, {
          "content-type":"text/csv; charset=utf-8",
          "cache-control":"no-store, max-age=0",
          "access-control-allow-origin":"*"
        });
        res.end(lines.join("\n"));
      } catch (error) {
        res.writeHead(500, {"content-type":"application/json"});
        res.end(JSON.stringify({error:"us_hvac_export_failed",message:error?.message||"unknown"}));
      }
    })();
    return;
  }
  if (requestUrl.pathname === "/exports/ny-hvac-leads.csv" && req.method === "GET") {
    void (async () => {
      try {
        const redis = await getAcquisitionRedis();
        const values = await redis.hVals("recover:leadstore:qualified");
        const rows = values.map(v => { try { return JSON.parse(v); } catch { return null; } }).filter(Boolean)
          .filter(lead => {
            const hay = [lead.address, lead.city, lead.region, lead.acquisition_location].filter(Boolean).join(" ").toLowerCase();
            const noWebsite = !String(lead.website||"").trim();
            const emails = Array.isArray(lead.emails) ? lead.emails : String(lead.email||lead.emails||"").split(/[;,\s]+/).filter(Boolean);
            const contactable = !!String(lead.phone||"").trim() || emails.length>0;
            const address = String(lead.address||"").toLowerCase();
            const region = String(lead.region||"").toLowerCase();
            const city = String(lead.city||"").toLowerCase();
            const explicitOtherState = /,\s*(al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy)\b/i.test(address);
            const explicitNY = /,\s*ny\b|new york\b/i.test(address) || /\bny\b|new york/.test(region) || /new york/.test(city);
            const fallbackNY = !address && !region && !city && /new york|\bny\b/.test(String(lead.acquisition_location||"").toLowerCase());
            const inNY = !explicitOtherState && (explicitNY || fallbackNY);
            return noWebsite && contactable && inNY && isCoreHomeServiceLead(lead);
          })
          .sort((a,b)=>String(a.name||"").localeCompare(String(b.name||"")));
        const esc = value => {
          const text = Array.isArray(value) ? value.join(", ") : String(value ?? "");
          return '"' + text.replace(/"/g,'""') + '"';
        };
        const header = ["Business Name","Category","Address","City","Region","Phone","Email","Website","Google Maps URL","Place ID","Review Count","Rating","Qualification Score","Acquisition Location","Acquisition ID","Status"];
        const lines=[header.map(esc).join(",")];
        for(const lead of rows){
          lines.push([
            lead.name||"",lead.category||"",lead.address||"",lead.city||"",lead.region||"",lead.phone||"",
            lead.emails||lead.email||"",lead.website||"",lead.google_maps_url||"",lead.place_id||"",
            lead.review_count||0,lead.review_rating||lead.rating||0,lead.qualification?.score||0,
            lead.acquisition_location||"",lead.acquisition_id||"","auto"
          ].map(esc).join(","));
        }
        res.writeHead(200, {
          "content-type":"text/csv; charset=utf-8",
          "cache-control":"no-store, max-age=0",
          "access-control-allow-origin":"*"
        });
        res.end(lines.join("\n"));
      } catch (error) {
        res.writeHead(500, {"content-type":"application/json"});
        res.end(JSON.stringify({error:"export_failed",message:error?.message||"unknown"}));
      }
    })();
    return;
  }
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
      const dependenciesOk = required.every(name => backends[name]?.reachable === true);
      // Railway health checks should prove the MCP process is alive, not couple
      // deployment viability to every downstream scraper dependency. Expose
      // dependency degradation in the payload so Recover can surface it.
      res.writeHead(200, {"content-type":"application/json"});
      res.end(JSON.stringify({
        ok:true,
        degraded:!dependenciesOk,
        dependencies_ok:dependenciesOk,
        name:"recover-scrape-mcp",
        backends
      }));
    })();
    return;
  }
  if (requestUrl.pathname === "/mcp") {
    if (MCP_AUTH_TOKEN || MCP_AUTH_TOKEN_SECONDARY) {
      const auth = req.headers.authorization || "";
      const allowed = [
        MCP_AUTH_TOKEN ? `Bearer ${MCP_AUTH_TOKEN}` : "",
        MCP_AUTH_TOKEN_SECONDARY ? `Bearer ${MCP_AUTH_TOKEN_SECONDARY}` : "",
      ].filter(Boolean);
      const oauthAccess = auth.startsWith("Bearer ") ? verifyOauthToken(auth.slice(7), "access") : null;
      if (!allowed.includes(auth) && !oauthAccess) {
        const headers = {"content-type":"application/json"};
        if (oauthEnabled) headers["www-authenticate"] = `Bearer resource_metadata="${OAUTH_ISSUER}/.well-known/oauth-protected-resource/mcp"`;
        res.writeHead(401, headers);
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
  void (async () => {
    try {
      const redis = await getAcquisitionRedis();
      const values = await redis.hVals("recover:leadstore:qualified");
      let parsed=0, noWebsite=0, contactable=0, noWebsiteContactable=0, coreNoWebsiteContactable=0, withWebsite=0;
      for (const value of values) {
        let lead; try { lead=JSON.parse(value); } catch { continue; }
        if (!lead) continue;
        parsed++;
        const website=String(lead.website||"").trim();
        const emails=Array.isArray(lead.emails) ? lead.emails : String(lead.email||lead.emails||"").split(/[;,\\s]+/).filter(Boolean);
        const hasContact=Boolean(String(lead.phone||"").trim())||emails.length>0;
        const nw=!website;
        if(nw) noWebsite++; else withWebsite++;
        if(hasContact) contactable++;
        if(nw&&hasContact) noWebsiteContactable++;
        if(nw&&hasContact&&isCoreHomeServiceLead(lead)) coreNoWebsiteContactable++;
      }
      console.log(JSON.stringify({event:"qualified_lead_store_stats",redis_hash_entries:values.length,parsed,no_website:noWebsite,with_website:withWebsite,contactable,no_website_contactable:noWebsiteContactable,core_home_service_no_website_contactable:coreNoWebsiteContactable}));
    } catch (error) {
      console.error("qualified_lead_store_stats_error", error);
    }
  })();
});

// Trigger live NY export route redeploy 2026-09-09T09:08Z

// classifier refresh trigger 2026-09-10

// strict classifier refresh trigger 2026-09-10
