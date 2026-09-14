import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

test("leadstore stats hook exposes exact aggregate counts", async () => {
  const helperUrl = new URL("./leadstore-stats.mjs", import.meta.url);
  const hookUrl = new URL("./stats-hook.mjs", import.meta.url);

  assert.equal(existsSync(fileURLToPath(helperUrl)), true, "leadstore stats helper must exist");
  assert.equal(existsSync(fileURLToPath(hookUrl)), true, "stats HTTP hook must exist");

  const { summarizeLeadValues } = await import(helperUrl.href);
  const stats = summarizeLeadValues([
    JSON.stringify({ website: "", phone: "555-1000", emails: [] }),
    JSON.stringify({ website: "https://example.com", phone: "", email: "owner@example.com" }),
    JSON.stringify({ website: null, phone: "", emails: ["team@example.com"] }),
    "not-json"
  ], 4);

  assert.deepEqual(stats, {
    qualified_total: 4,
    parsed_records: 3,
    invalid_records: 1,
    no_website: 2,
    with_phone: 1,
    with_email: 2,
    contactable: 3
  });

  const hookSource = await readFile(hookUrl, "utf8");
  assert.match(hookSource, /\/stats\/leadstore/);
  assert.match(hookSource, /hLen\(/);
  assert.match(hookSource, /hVals\(/);
});
