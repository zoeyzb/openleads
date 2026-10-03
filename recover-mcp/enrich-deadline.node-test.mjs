import assert from "node:assert/strict";
import { withOperationDeadline } from "./enrich-deadline.mjs";

assert.equal(await withOperationDeadline(Promise.resolve("ok"),50,"fast"),"ok");

const started=Date.now();
await assert.rejects(
  withOperationDeadline(new Promise(()=>{}),25,"hung-enrich"),
  /hung-enrich timed out after 25ms/
);
assert.ok(Date.now()-started<250,"deadline must release a hung promise promptly");

console.log("enrich deadline tests passed");
