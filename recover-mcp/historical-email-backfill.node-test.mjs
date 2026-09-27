import assert from 'node:assert/strict';
import {buildIdentityIndex, chooseHistoricalMatch} from './historical-email-match.mjs';

const dup=[
 {key:'a',lead:{name:'Same Co',address:'1 Main St',phone:'3125551212'}},
 {key:'b',lead:{name:'Other Co',address:'2 Main St',phone:'3125551212'}},
];
const index=buildIdentityIndex(dup);
assert.equal(chooseHistoricalMatch({name:'Unknown',address:'',phone:'3125551212'},index),null,'ambiguous phone must not match');
assert.equal(chooseHistoricalMatch({name:'Same Co',address:'1 Main Street',phone:''},index)?.key,'a');
console.log('historical email backfill safety tests passed');
