import assert from 'node:assert/strict';
import { geoBiasForJob } from './geo-coverage.mjs';

const job={source_latitude:41.8781,source_longitude:-87.6298,source_city_population:2700000,partition_state:'IL',partition_city:'Chicago',partition_zip:'60601'};
const p8=geoBiasForJob(job,8);
const p15=geoBiasForJob(job,15);
const p16=geoBiasForJob(job,16);
const p24=geoBiasForJob(job,24);
assert.equal(p8.ring,0);
assert.equal(p15.ring,0);
assert.equal(p16.ring,1);
assert.equal(p24.ring,2);
assert.ok(p16.distanceKm>p8.distanceKm,'later coverage pass must move outward');
assert.ok(p24.distanceKm>p16.distanceKm,'later rings must keep expanding');
assert.ok(p8.radius>=8000&&p8.radius<=20000);
assert.ok(p16.radius>=8000&&p16.radius<=25000);
console.log('geo coverage tests passed');