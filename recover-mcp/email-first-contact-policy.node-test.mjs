import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const worker=await readFile(new URL('./acquisition-worker.mjs',import.meta.url),'utf8');
const national=await readFile(new URL('./us-hvac-controller-v3.mjs',import.meta.url),'utf8');
const secondary=await readFile(new URL('./secondary-discovery-worker.mjs',import.meta.url),'utf8');
const historical=await readFile(new URL('./historical-email-backfill.mjs',import.meta.url),'utf8');

test('core home-service worker no longer forces phone-only qualification',()=>{
  assert.match(worker,/job\.require_phone=false;/);
  assert.match(worker,/job\.require_email=false;/);
  assert.match(worker,/job\.require_contact=true;/);
  assert.doesNotMatch(worker,/job\.require_phone=true;/);
});

test('national controller seeds contactable jobs without requiring phone',()=>{
  assert.match(national,/require_contact:true,require_phone:false,require_email:false/);
});

test('secondary discovery accepts email-only businesses and records email preference',()=>{
  assert.match(secondary,/if\(!phones\.length&&!emails\.length\) return \{accepted:false,reason:"contact"\}/);
  assert.match(secondary,/preferred_contact_channel:emails\.length\?"email":"phone"/);
});

test('historical Supabase email recovery uses bounded retry backoff',()=>{
  assert.match(historical,/retry_in_ms:delayMs/);
  assert.match(historical,/await sleep\(delayMs\)/);
});
