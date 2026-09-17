import test from 'node:test';
import assert from 'node:assert/strict';
import { patchControllerSource } from './controller-yield-runtime.mjs';

test('patches controller area ordering regardless of whitespace', () => {
  const src = `import { deriveSchedulerCapacity } from './nationwide-shard-scheduler.mjs';\nasync function fetchZipAreas(){\n  return   partitionNationwideAreas ( out ) ;\n}`;
  const out = patchControllerSource(src);
  assert.match(out, /import \{ orderControllerAreas \} from '\.\/us-hvac-area-order\.mjs';/);
  assert.match(out, /return orderControllerAreas\(out\);/);
  assert.doesNotMatch(out, /return\s+partitionNationwideAreas\s*\(/);
});

test('is idempotent when source is already patched', () => {
  const src = `import { orderControllerAreas } from './us-hvac-area-order.mjs';\nasync function fetchZipAreas(){ return orderControllerAreas(out); }`;
  assert.equal(patchControllerSource(src), src);
});
