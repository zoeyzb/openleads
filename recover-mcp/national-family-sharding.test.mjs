import test from 'node:test';
import assert from 'node:assert/strict';
import { queryPassForIndex, workUnitForCursor, FAMILY_SHARDS } from './national-family-sharding.mjs';

function workerHash(value){
  let hash=0;
  for(const ch of String(value||'')) hash=(hash*31+ch.charCodeAt(0))>>>0;
  return hash;
}

test('coverage pass deterministically selects the requested worker query index',()=>{
  const location='10001 New York, NY';
  for(const family of FAMILY_SHARDS){
    const pass=queryPassForIndex(location,family.queryIndex,'v4');
    assert.equal(workerHash(`${location}|${pass}`)%20,family.queryIndex);
  }
});

test('cursor expands each ZIP into every service-family shard before advancing ZIP',()=>{
  const areas=[{zip:'10001',city:'New York',state:'NY',location:'10001 New York, NY'},{zip:'90001',city:'Los Angeles',state:'CA',location:'90001 Los Angeles, CA'}];
  const first=workUnitForCursor(areas,0);
  const lastFirstZip=workUnitForCursor(areas,FAMILY_SHARDS.length-1);
  const firstSecondZip=workUnitForCursor(areas,FAMILY_SHARDS.length);
  assert.equal(first.area.zip,'10001');
  assert.equal(lastFirstZip.area.zip,'10001');
  assert.equal(firstSecondZip.area.zip,'90001');
  assert.equal(first.family.key,FAMILY_SHARDS[0].key);
});
