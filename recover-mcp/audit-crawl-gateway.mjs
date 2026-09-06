import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

export function isAuthorized(header, token) {
  if (!token) return false;
  return String(header || "") === `Bearer ${token}`;
}

export function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

export async function proxyCrawlRequest(req, res, env = process.env, fetchImpl = fetch) {
  const backendUrl = normalizeBaseUrl(env.CRAWL4AI_BASE_URL);
  const backendToken = String(env.CRAWL4AI_API_TOKEN || "");
  const gatewayToken = String(env.AUDIT_CRAWL_GATEWAY_TOKEN || "");

  if (!isAuthorized(req.headers.authorization, gatewayToken)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  if (!backendUrl || !backendToken) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "crawl_backend_not_configured" }));
    return;
  }

  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 2_000_000) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "payload_too_large" }));
      return;
    }
  }

  const upstream = await fetchImpl(`${backendUrl}/crawl`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${backendToken}`,
      "content-type": req.headers["content-type"] || "application/json",
      accept: "application/json",
    },
    body,
    signal: AbortSignal.timeout(60_000),
  });
  const payload = await upstream.text();
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") || "application/json",
    "cache-control": "no-store",
  });
  res.end(payload);
}

export function createAuditCrawlGateway(env = process.env, fetchImpl = fetch) {
  return createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        const configured = Boolean(env.CRAWL4AI_BASE_URL && env.CRAWL4AI_API_TOKEN && env.AUDIT_CRAWL_GATEWAY_TOKEN);
        res.writeHead(configured ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: configured, name: "recover-audit-crawl-gateway" }));
        return;
      }
      if (req.method === "POST" && req.url === "/crawl") {
        await proxyCrawlRequest(req, res, env, fetchImpl);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
    } catch (error) {
      console.error("Audit crawl gateway error", error);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "crawl_gateway_failed" }));
    }
  });
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  const port = Number(process.env.PORT || 3000);
  createAuditCrawlGateway().listen(port, "0.0.0.0", () => {
    console.log(`Recover audit crawl gateway listening on 0.0.0.0:${port}`);
  });
}
