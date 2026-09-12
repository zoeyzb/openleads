import test from 'node:test';
import assert from 'node:assert/strict';
import { buildYieldStats, rankFamilies, weightedFamilySchedule, prioritizeAreas } from './national-yield-priority.mjs';

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
