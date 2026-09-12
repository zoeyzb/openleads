import test from "node:test";
import assert from "node:assert/strict";
import {
  LEGACY_FAST_WAIT,
  LEGACY_LANE_COOLDOWN,
  LEGACY_MAPS_DONE,
  LEGACY_QUEUE_POLL,
  patchAcquisitionWorkerSource,
} from "./acquisition-worker-runtime.mjs";

function fixture(){
  return `before\n${LEGACY_FAST_WAIT}\n${LEGACY_LANE_COOLDOWN}\n${LEGACY_MAPS_DONE}\n${LEGACY_QUEUE_POLL}\nafter`;
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

test("refuses to start if upstream worker no longer matches expected contract",()=>{
  assert.throws(()=>patchAcquisitionWorkerSource("no legacy timeout here"),/expected exactly one/);
});
