import test from "node:test";
import assert from "node:assert/strict";
import {
  LEGACY_FAST_WAIT,
  LEGACY_LANE_COOLDOWN,
  LEGACY_MAPS_DONE,
  LEGACY_QUEUE_POLL,
  LEGACY_WORKER_LOOP,
  patchAcquisitionWorkerSource,
} from "./acquisition-worker-runtime.mjs";

function fixture(){
  return `before\n${LEGACY_FAST_WAIT}\n${LEGACY_LANE_COOLDOWN}\n${LEGACY_MAPS_DONE}\n${LEGACY_WORKER_LOOP}\nafter`;
}

test("extends fast Maps status budget beyond backend 180-second minimum",()=>{
  const patched=patchAcquisitionWorkerSource(fixture());
  assert.match(patched,/Math\.max\(180,requestedMaxSeconds\)\+45/);
  assert.doesNotMatch(patched,/fastProfile \? 90\*1000/);
});

test("adds adaptive exponential cooldown and clears it after a healthy job",()=>{
  const patched=patchAcquisitionWorkerSource(fixture());
  assert.match(patched,/mapsLaneFailureKey/);
  assert.match(patched,/Math\.min\(900,75\*\(2\*\*Math\.min\(4/);
  assert.match(patched,/await clearMapsLaneFailure\(mapsBase\)/);
});

test("prioritizes US city coverage ahead of the general nationwide queue",()=>{
  const patched=patchAcquisitionWorkerSource(fixture());
  const city=patched.indexOf('recover:acquisition:queue:us-city-priority');
  const general=patched.lastIndexOf('recover:acquisition:queue"');
  assert.ok(city>=0);
  assert.ok(general>city);
});

test("runs multiple acquisition loops inside each worker process",()=>{
  const patched=patchAcquisitionWorkerSource(fixture());
  assert.match(patched,/ACQUISITION_WORKER_CONCURRENCY/);
  assert.match(patched,/Promise\.all\(Array\.from\(\{length:workerConcurrency\}/);
  assert.match(patched,/worker slot/);
});

test("refuses to start if upstream worker no longer matches expected contract",()=>{
  assert.throws(()=>patchAcquisitionWorkerSource("no legacy timeout here"),/expected exactly one/);
});
