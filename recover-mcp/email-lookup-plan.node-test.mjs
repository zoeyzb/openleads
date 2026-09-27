import assert from 'node:assert/strict';
import { buildLookupPlan } from './email-lookup-plan.mjs';
let p=buildLookupPlan({business:'Acme HVAC',phone:'3125551212',location:'Chicago IL',address:'1 Main St Chicago IL',noWebsite:true});
assert.equal(p.stage1.length,3);
assert.ok(p.stage1[0].includes('3125551212'));
assert.ok(p.stage2.length>=4);
p=buildLookupPlan({business:'Acme HVAC',phone:'3125551212',location:'Chicago IL',address:'1 Main St Chicago IL',noWebsite:false});
assert.ok(p.stage1.some(x=>/email|contact/i.test(x)));
console.log('email lookup plan tests passed');