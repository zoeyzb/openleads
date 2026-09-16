import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./us-hvac-controller.mjs', import.meta.url), 'utf8');

test('controller orders nationwide ZIPs with the existing population-priority scheduler', () => {
  assert.match(
    source,
    /import\s*\{\s*prioritizeAreas\s*\}\s*from\s*["']\.\/national-yield-priority\.mjs["']/,
    'controller should import prioritizeAreas from national-yield-priority.mjs'
  );
  assert.match(
    source,
    /return\s+prioritizeAreas\(out\)\s*;/,
    'fetchZipAreas should prioritize parsed ZIPs by population tiers before seeding'
  );
});
