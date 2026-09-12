import test from 'node:test';
import assert from 'node:assert/strict';
import { buildYieldStats, rankFamilies, weightedFamilySchedule, prioritizeAreas, buildCoverageYieldSchedule, buildCityFirstCoverageAreas } from './national-yield-priority.mjs';

test('ranks high-yield families ahead of zero-yield families after enough evidence',()=>{
  const jobs=[];
  for(let i=0;i<40;i++) jobs.push({service_family:'hvac',stored_count:i<20?2:1,status:'partial_complete'});
  for(let i=0;i<40;i++) jobs.push({service_family:'duct',stored_count:0,status:'partial_complete'});
  const stats=buildYieldStats(jobs);
  const ranked=rankFamilies(['hvac','duct','plumbing'],stats);
  assert.equal(ranked[0],'hvac');
  assert.equal(ranked.at(-1),'duct');
});

test('keeps exploration for low-yield families instead of starving them',()=>{
  const ranked=['hvac','plumbing','duct','ventilation'];
  const schedule=weightedFamilySchedule(ranked,20);
  assert.ok(schedule.filter(x=>x==='hvac').length > schedule.filter(x=>x==='duct').length);
  assert.ok(schedule.includes('duct'));
  assert.ok(schedule.includes('ventilation'));
});

test('prioritizes dense ZIPs while still interleaving states',()=>{
  const areas=[
    {zip:'1',state:'CA',population:30000},{zip:'2',state:'CA',population:20000},
    {zip:'3',state:'TX',population:28000},{zip:'4',state:'TX',population:18000},
    {zip:'5',state:'WY',population:1000}
  ];
  const out=prioritizeAreas(areas);
  assert.deepEqual(out.slice(0,4).map(x=>x.zip),['1','3','2','4']);
  assert.equal(out.at(-1).zip,'5');
});

test('guarantees most batch slots remain reserved for nationwide coverage',()=>{
  const out=buildCoverageYieldSchedule(['hvac','plumbing','duct'],['hvac','plumbing','duct'],12,0.7);
  assert.equal(out.length,12);
  assert.ok(out.filter(x=>x.mode==='coverage').length>=8);
  assert.ok(out.filter(x=>x.mode==='yield').length<=4);
});

test('coverage lane round-robins every family rather than starving low-yield families',()=>{
  const out=buildCoverageYieldSchedule(['hvac','plumbing','duct'],['hvac','plumbing','duct'],9,0.67);
  const coverage=out.filter(x=>x.mode==='coverage').map(x=>x.family);
  assert.ok(coverage.includes('hvac'));
  assert.ok(coverage.includes('plumbing'));
  assert.ok(coverage.includes('duct'));
});

test('city-first coverage visits every city before secondary ZIPs in a city',()=>{
  const areas=[
    {zip:'90001',city:'Los Angeles',state:'CA',population:50000},
    {zip:'90002',city:'Los Angeles',state:'CA',population:40000},
    {zip:'94102',city:'San Francisco',state:'CA',population:30000},
    {zip:'77001',city:'Houston',state:'TX',population:45000},
    {zip:'77002',city:'Houston',state:'TX',population:35000},
    {zip:'73301',city:'Austin',state:'TX',population:25000},
  ];
  const out=buildCityFirstCoverageAreas(areas);
  const firstFour=new Set(out.slice(0,4).map(x=>`${x.state}:${x.city}`));
  assert.equal(firstFour.size,4);
  assert.equal(out.length,6);
});
