import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source=await readFile(new URL('./us-hvac-family-controller.mjs',import.meta.url),'utf8');

test('adaptive yield stats sample the current nationwide batch instead of the global acquisition index',()=>{
  assert.match(source,/sRandMember\(BATCH_JOB_SET,YIELD_SAMPLE_SIZE\)/);
  assert.doesNotMatch(source,/sRandMember\('recover:acq:index',YIELD_SAMPLE_SIZE\)/);
});

test('city coverage has an independent priority floor before total queue backpressure',()=>{
  assert.match(source,/US_FAMILY_CITY_PRIORITY_TARGET/);
  const floor=source.indexOf('queue.city<CITY_PRIORITY_TARGET');
  const backpressure=source.indexOf('queue.total>=QUEUE_HIGH_WATER');
  assert.ok(floor>=0,'missing city-priority floor');
  assert.ok(backpressure>floor,'total backpressure must be checked after city-priority floor');
});
