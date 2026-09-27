import assert from 'node:assert/strict';
import { buildIdentityIndex, chooseHistoricalMatch } from './historical-email-match.mjs';
const rows=[
 {key:'a',lead:{name:'Alpha HVAC',address:'1 Main Street',phone:'3125550000',place_id:'PLACE_A'}},
 {key:'b',lead:{name:'Beta HVAC',address:'2 Main Street',phone:'3125559999',place_id:'PLACE_B'}}
];
const idx=buildIdentityIndex(rows);
assert.equal(chooseHistoricalMatch({name:'Beta HVAC',address:'2 Main St',phone:'3125550000',place_id:'PLACE_B'},idx).key,'b');
assert.equal(chooseHistoricalMatch({name:'Alpha HVAC',address:'1 Main St',phone:'3125559999'},idx).key,'a');
assert.equal(chooseHistoricalMatch({phone:'3125550000'},idx).key,'a');
console.log('historical identity priority tests passed');