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

test("respects explicit lower overrides and clamps unsafe values",()=>{
  assert.equal(deriveSchedulerCapacity({workerCount:4,mapsLaneCount:6,queueHighWater:96,seedBatchSize:24}).queueHighWater,96);
  assert.equal(deriveSchedulerCapacity({workerCount:40,mapsLaneCount:40,queueHighWater:999,seedBatchSize:999}).queueHighWater,288);
  assert.equal(deriveSchedulerCapacity({workerCount:40,mapsLaneCount:40,queueHighWater:999,seedBatchSize:999}).seedBatchSize,72);
});

test("assigns an area to a stable shard",()=>{
  const area={state:"TX",city:"Austin",zip:"78701"};
  const first=shardIdForArea(area,6);
  assert.match(first,/^shard-0[1-6]-of-06$/);
  assert.equal(first,shardIdForArea(area,6));
  assert.notEqual(first,shardIdForArea({...area,zip:"78702"},6));
});
