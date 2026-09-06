import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createAuditCrawlGateway, isAuthorized, normalizeBaseUrl } from "./audit-crawl-gateway.mjs";

test("authorization requires exact bearer token", () => {
  assert.equal(isAuthorized("Bearer secret", "secret"), true);
  assert.equal(isAuthorized("Bearer wrong", "secret"), false);
  assert.equal(isAuthorized("", "secret"), false);
  assert.equal(isAuthorized("Bearer secret", ""), false);
});

test("normalizes backend base URL", () => {
  assert.equal(normalizeBaseUrl("https://example.test/"), "https://example.test");
});

test("gateway proxies an authorized crawl request without exposing backend credentials", async (t) => {
  let upstream = null;
  const fakeFetch = async (url, init) => {
    upstream = { url, init };
    return new Response(JSON.stringify({ ok: true, results: [{ url: "https://example.com" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const env = {
    CRAWL4AI_BASE_URL: "http://crawl4ai.internal:11235/",
    CRAWL4AI_API_TOKEN: "backend-token",
    AUDIT_CRAWL_GATEWAY_TOKEN: "gateway-token",
  };
  const server = createAuditCrawlGateway(env, fakeFetch).listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const port = server.address().port;

  const response = await fetch(`http://127.0.0.1:${port}/crawl`, {
    method: "POST",
    headers: { authorization: "Bearer gateway-token", "content-type": "application/json" },
    body: JSON.stringify({ urls: ["https://example.com"] }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, results: [{ url: "https://example.com" }] });
  assert.equal(upstream.url, "http://crawl4ai.internal:11235/crawl");
  assert.equal(upstream.init.headers.authorization, "Bearer backend-token");
});

test("gateway rejects unauthorized crawl requests", async (t) => {
  const env = {
    CRAWL4AI_BASE_URL: "http://crawl4ai.internal:11235",
    CRAWL4AI_API_TOKEN: "backend-token",
    AUDIT_CRAWL_GATEWAY_TOKEN: "gateway-token",
  };
  const server = createAuditCrawlGateway(env, async () => { throw new Error("should not call upstream"); }).listen(0, "127.0.0.1");
  t.after(() => server.close());
  await once(server, "listening");
  const port = server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/crawl`, { method: "POST" });
  assert.equal(response.status, 401);
});
