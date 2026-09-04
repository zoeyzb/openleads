import { createServer as createHttpServer } from "node:http";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod/v4";
import { orchestrate as enrichEmail } from "email-enrich";

const PORT = Number(process.env.PORT || 3000);
const MAPS_BASE_URL = (process.env.MAPS_BASE_URL || "").replace(/\/$/, "");
const CRAWL4AI_BASE_URL = (process.env.CRAWL4AI_BASE_URL || "").replace(/\/$/, "");
const CRAWL4AI_API_TOKEN = process.env.CRAWL4AI_API_TOKEN || "";
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || "";

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

function scoreLead(lead) {
  let score = 0;
  const reasons = [];
  const add = (points, reason) => { score += points; reasons.push({ points, reason }); };
  const category = normalizeText(lead.category || lead.industry || "");
  if (/hvac|heating|air conditioning|plumb|roof|electric/.test(category)) add(15, "target local-service category");
  if (!lead.website) add(20, "no website");
  if (lead.website && (lead.website_issues || lead.bad_website || lead.outdated_website)) add(15, "website has conversion/quality issues");
  const reviews = Number(lead.review_count || lead.reviews || 0);
  if (reviews >= 20) add(10, "20+ reviews");
  if (Number(lead.review_rating || lead.rating || 0) >= 4.2) add(5, "strong rating");
  if (lead.phone) add(10, "phone available");
  if (lead.email || (Array.isArray(lead.emails) && lead.emails.length)) add(10, "email available");
  if (lead.owner || lead.owner_name) add(10, "owner signal available");
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
        "Use Recover Scrape for business discovery, Google Maps scraping, website crawling, public-contact enrichment, deduplication and lead qualification. Prefer maps_start_job for local-business discovery, crawl_website for website analysis, enrich_email for public professional-email enrichment, dedupe_leads before returning large lead sets, and qualify_leads to rank prospects. Never claim an email or owner identity is verified unless the returned evidence supports it."
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
      components: {
        googleMaps: "zoeyzb/google-maps-scraper",
        crawl4ai: "zoeyzb/crawl4ai",
        firecrawl: "zoeyzb/firecrawl (external/optional adapter)",
        openleads: "zoeyzb/openleads",
        aura: "zoeyzb/aura-app (reference/enrichment patterns)",
        gtmSignalScoring: "zoeyzb/gtm-signal-scoring (scoring reference; full app needs DB/provider keys)",
        gtmSkills: "zoeyzb/gtm-skills (agent playbooks, not a runtime service)",
        emailEnrich: "zoeyzb/email-enrich",
        dedupe: "zoeyzb/dedupe",
        leadQualifier: "zoeyzb/LeadQualifier (offline ML reference)",
        aiLeadScoring: "zoeyzb/ai-lead-scoring-qualification (n8n reference workflow)"
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
    const body = { name: name || `Recover Scrape ${new Date().toISOString()}`, keywords, depth, max_time, extra_reviews };
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
    res.writeHead(200, {"content-type":"application/json"});
    res.end(JSON.stringify({ok:true,name:"recover-scrape-mcp"}));
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
