import test from 'node:test';
import assert from 'node:assert/strict';
import { orderControllerAreas } from './us-hvac-area-order.mjs';

test('controller prioritizes high-population ZIP tiers before tiny areas while keeping state diversity', () => {
  const rows = [
    {zip:'10001',city:'Big A',state:'NY',population:50000},
    {zip:'90001',city:'Big B',state:'CA',population:45000},
    {zip:'73301',city:'Medium',state:'TX',population:12000},
    {zip:'59001',city:'Tiny',state:'MT',population:300},
    {zip:'82001',city:'Tiny 2',state:'WY',population:200},
  ];
  const ordered = orderControllerAreas(rows);
  assert.deepEqual(ordered.slice(0,2).map(x=>x.population), [50000,45000]);
  assert.equal(ordered[2].population, 12000);
  assert.ok(ordered.slice(3).every(x=>x.population < 2500));
});
