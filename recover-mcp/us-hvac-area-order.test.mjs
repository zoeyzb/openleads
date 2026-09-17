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

test('first nationwide coverage wave visits distinct cities before a second ZIP in one city', () => {
  const rows=[
    {state:'TX',city:'Houston',zip:'77001',population:60000},
    {state:'TX',city:'Houston',zip:'77002',population:50000},
    {state:'TX',city:'Austin',zip:'78701',population:40000},
    {state:'CA',city:'Los Angeles',zip:'90001',population:55000},
    {state:'CA',city:'San Diego',zip:'92101',population:35000},
  ];
  const out=orderControllerAreas(rows);
  const firstFour=out.slice(0,4).map(x=>`${x.state}:${x.city}`);
  assert.equal(new Set(firstFour).size,4);
});
