import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./acquisition-worker.mjs", import.meta.url), "utf8");

test("uses separate short TTLs for raw and compact acquisition state", () => {
  assert.match(source, /ACQUISITION_RAW_TTL_SECONDS\s*\|\|\s*7200/);
  assert.match(source, /ACQUISITION_RESULT_TTL_SECONDS\s*\|\|\s*86400/);
  assert.match(source, /async function replaceList\(key,values,ttlSeconds\)/);
  assert.match(source, /redis\.expire\(key,ttlSeconds\)/);
});

test("writes raw and result lists with their own TTLs", () => {
  assert.match(source, /replaceList\(rawKey\(id\),allRaw,RAW_TTL_SECONDS\)/);
  const resultCalls = source.match(/replaceList\(resultsKey\(id\),[^\n]+RESULT_TTL_SECONDS\)/g) || [];
  assert.ok(resultCalls.length >= 3, `expected >=3 result TTL writes, got ${resultCalls.length}`);
});

test("terminal successful acquisitions delete raw payloads", () => {
  assert.match(source, /async function deleteRawForJob\(id\)/);
  assert.match(source, /redis\.del\(rawKey\(id\)\)/);
  const cleanupCalls = source.match(/await deleteRawForJob\(id\);/g) || [];
  assert.ok(cleanupCalls.length >= 3, `expected >=3 terminal raw cleanup calls, got ${cleanupCalls.length}`);
});
