import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("server exposes read-only leadstore stats endpoint", async () => {
  const source = await readFile(new URL("./server.mjs", import.meta.url), "utf8");
  assert.match(source, /requestUrl\.pathname === "\/stats\/leadstore"/);
  assert.match(source, /recover:leadstore:qualified/);
  assert.match(source, /qualified_total/);
  assert.match(source, /no_website/);
  assert.match(source, /with_phone/);
  assert.match(source, /with_email/);
});
