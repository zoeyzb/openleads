import test from 'node:test';
import assert from 'node:assert/strict';
import { patchControllerSource } from './controller-yield-runtime.mjs';

test('patches controller area ordering regardless of whitespace', () => {
  const src = `import { deriveSchedulerCapacity } from './nationwide-shard-scheduler.mjs';\nasync function fetchZipAreas(){\n  return   partitionNationwideAreas ( out ) ;\n}`;
  const out = patchControllerSource(src);
  assert.match(out, /import \{ orderControllerAreas, locationForCoveragePass \} from '\.\/us-hvac-area-order\.mjs';/);
  assert.match(out, /return orderControllerAreas\(out\);/);
  assert.doesNotMatch(out, /return\s+partitionNationwideAreas\s*\(/);
});

test('million target starts broad city coverage pass and uses city location', () => {
  const src = `import { deriveSchedulerCapacity } from './nationwide-shard-scheduler.mjs';\nasync function fetchZipAreas(){ return partitionNationwideAreas(out); }\nconst areas=await fetchZipAreas();\nlet cursor=Number(await redis.hGet(CONTROLLER_KEY,"cursor")||0); let coveragePass=Math.max(1,Number(await redis.hGet(CONTROLLER_KEY,"coverage_pass")||1));\nasync function seedOne(area){const job={location:area.location,target:TARGET_PER_AREA};}`;
  const out=patchControllerSource(src);
  assert.match(out,/TARGET_TOTAL>=1000000&&coveragePass===1/);
  assert.match(out,/coveragePass=2;cursor=0/);
  assert.match(out,/location:locationForCoveragePass\(area,coveragePass\)/);
});

test('is idempotent when all source patches are already present', () => {
  const src = `import { orderControllerAreas, locationForCoveragePass } from './us-hvac-area-order.mjs';\nasync function fetchZipAreas(){ return orderControllerAreas(out); }\nconst areas=await fetchZipAreas();\nlet cursor=0; let coveragePass=2;\nif(TARGET_TOTAL>=1000000&&coveragePass===1){coveragePass=2;cursor=0;}\nasync function seedOne(area){const job={location:locationForCoveragePass(area,coveragePass)};}`;
  assert.equal(patchControllerSource(src), src);
});
