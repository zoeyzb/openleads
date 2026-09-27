import assert from 'node:assert/strict';
import { searchQueries } from './email-enrichment-evidence.mjs';
const q=searchQueries({business:'Acme Heating LLC',phone:'(312) 555-1212',location:'Chicago IL'});
assert.ok(q[0].includes('3125551212'),'exact phone must be first lookup');
assert.ok(q.slice(0,2).some(x=>x.includes('acme heating')&&x.includes('3125551212')),'business+phone must be in first two lookups');
console.log('email query priority tests passed');