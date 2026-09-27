import assert from 'node:assert/strict';
import { backfillRetryDelayMs } from './historical-email-backoff.mjs';
assert.equal(backfillRetryDelayMs(0), 5*60*1000);
assert.equal(backfillRetryDelayMs(1), 10*60*1000);
assert.equal(backfillRetryDelayMs(2), 20*60*1000);
assert.equal(backfillRetryDelayMs(10), 60*60*1000);
console.log('historical email backoff tests passed');