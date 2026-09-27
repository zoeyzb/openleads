import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source=await readFile(new URL('./secondary-discovery-worker.mjs',import.meta.url),'utf8');

test('secondary email queue does not require a phone number',()=>{
  assert.doesNotMatch(source,/if\(emails\.length\|\|!phone\|\|String\(lead\?\.website/);
  assert.doesNotMatch(source,/if\(phone\.length!==10\)\{await redis\.sRem\(EMAIL_PENDING_SET,key\);return \{ran:false,reason:"no_phone"\}/);
});

test('targeted email search is labeled email-first',()=>{
  assert.match(source,/search_mix:"email-first-google\+verified-directory"/);
});
