import test from 'node:test';
import assert from 'node:assert/strict';
import { nextControllerState } from './controller-cursor-reset.mjs';

test('cursor reset preserves controller state except cursor', () => {
  const before={cursor:'7715',coverage_pass:'1',last_area:'VT'};
  assert.deepEqual(nextControllerState(before),{cursor:'0',coverage_pass:'1',last_area:'VT'});
});
