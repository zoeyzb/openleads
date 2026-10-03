import assert from "node:assert/strict";
import { shouldThrottleGeneralForSizeReady, sizeReadyFailureDisposition } from "./law-lane-pressure.mjs";

assert.equal(shouldThrottleGeneralForSizeReady(0),false);
assert.equal(shouldThrottleGeneralForSizeReady(2),false,"two strict-email leads must not halve the headcount worker");
assert.equal(shouldThrottleGeneralForSizeReady(7),false);
assert.equal(shouldThrottleGeneralForSizeReady(8),true);
assert.equal(shouldThrottleGeneralForSizeReady(40),true);

assert.deepEqual(sizeReadyFailureDisposition(0),{nextAttempt:1,shouldRetry:true,exhausted:false});
assert.deepEqual(sizeReadyFailureDisposition(2),{nextAttempt:3,shouldRetry:true,exhausted:false});
assert.deepEqual(sizeReadyFailureDisposition(3),{nextAttempt:4,shouldRetry:false,exhausted:true});
assert.deepEqual(sizeReadyFailureDisposition(4),{nextAttempt:4,shouldRetry:false,exhausted:true});

console.log("law lane-pressure tests passed");
