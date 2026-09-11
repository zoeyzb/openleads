import test from "node:test";
import assert from "node:assert/strict";
import { deriveSchedulerCapacity, shardIdForArea } from "./nationwide-shard-scheduler.mjs";

test("derives 144/36 capacity from four workers and six maps lanes",()=>{
  assert.deepEqual(deriveSchedulerCapacity({workerCount:4,mapsLaneCount:6}),{
    workerCount:4,
    mapsLaneCount:6,
    queueHighWater:144,
    seedBatchSize:36,
    shardCount:6,
  });
});

test("uses the worker/maps bottleneck and respects explicit lower overrides",()=>{
  assert.deepEqual(deriveSchedulerCapacity({workerCount:2,mapsLaneCount:10}),{
    workerCount:2,
    mapsLaneCount:10,
    queueHighWater:72,
    seedBatchSize:18,
    shardCount:10,
  });
  const lowered=deriveSchedulerCapacity({workerCount:4,mapsLaneCount:6,queueHighWater:96,seedBatchSize:24});
  assert.equal(lowered.queueHighWater,96);
  assert.equal(lowered.seedBatchSize,24);
});

test("clamps unsafe values to operational limits",()=>{
  const capacity=deriveSchedulerCapacity({workerCount:40,mapsLaneCount:40,queueHighWater:999,seedBatchSize:999});
  assert.equal(capacity.queueHighWater,288);
  assert.equal(capacity.seedBatchSize,72);
  assert.equal(capacity.shardCount,32);
});

test("assigns an area to a stable shard",()=>{
  const area={state:"TX",city:"Austin",zip:"78701"};
  const first=shardIdForArea(area,6);
  assert.match(first,/^shard-0[1-6]-of-06$/);
  assert.equal(first,shardIdForArea(area,6));
  assert.notEqual(first,shardIdForArea({...area,zip:"78702"},6));
});
