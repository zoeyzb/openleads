import test from "node:test";
import assert from "node:assert/strict";
import {
  LEGACY_FAST_WAIT,
  patchAcquisitionWorkerSource,
} from "./acquisition-worker-runtime.mjs";

test("extends fast Maps status budget beyond backend 180-second minimum",()=>{
  const patched=patchAcquisitionWorkerSource(`before\n${LEGACY_FAST_WAIT}\nafter`);
  assert.match(patched,/Math\.max\(180,requestedMaxSeconds\)\+45/);
  assert.doesNotMatch(patched,/fastProfile \? 90\*1000/);
});

test("refuses to start if upstream worker no longer matches expected contract",()=>{
  assert.throws(()=>patchAcquisitionWorkerSource("no legacy timeout here"),/expected exactly one/);
});
