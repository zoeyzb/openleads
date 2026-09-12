import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleSetMembers } from './redis-sampling.mjs';

test('sampleSetMembers uses raw SRANDMEMBER COUNT and returns many members', async () => {
  const calls=[];
  const redis={
    async sendCommand(args){ calls.push(args); return ['a','b','c','d']; },
    async sRandMember(){ return 'wrong-single-member'; }
  };
  const out=await sampleSetMembers(redis,'recover:batch:test:jobs',800);
  assert.deepEqual(out,['a','b','c','d']);
  assert.deepEqual(calls,[['SRANDMEMBER','recover:batch:test:jobs','800']]);
});
