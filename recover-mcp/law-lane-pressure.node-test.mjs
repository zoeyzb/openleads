import assert from "node:assert/strict";
import { shouldThrottleGeneralForSizeReady, sizeReadyFailureDisposition, shouldScheduleLegacyRecoverable, shouldRunEmailConversionWorker, shouldCircuitBreakSource } from "./law-lane-pressure.mjs";

assert.equal(shouldThrottleGeneralForSizeReady(0),false);
assert.equal(shouldThrottleGeneralForSizeReady(2),false);
assert.equal(shouldThrottleGeneralForSizeReady(7),false);
assert.equal(shouldThrottleGeneralForSizeReady(8),true);
assert.equal(shouldThrottleGeneralForSizeReady(40),true);

assert.deepEqual(sizeReadyFailureDisposition(0),{nextAttempt:1,shouldRetry:true,exhausted:false});
assert.deepEqual(sizeReadyFailureDisposition(2),{nextAttempt:3,shouldRetry:true,exhausted:false});
assert.deepEqual(sizeReadyFailureDisposition(3),{nextAttempt:4,shouldRetry:false,exhausted:true});
assert.deepEqual(sizeReadyFailureDisposition(4),{nextAttempt:4,shouldRetry:false,exhausted:true});

assert.equal(shouldScheduleLegacyRecoverable({callingMode:true}),false,"legacy email recovery must never consume calling worker capacity");
assert.equal(shouldRunEmailConversionWorker({callingMode:true}),false,"dedicated email conversion must be off in calling mode");
assert.equal(shouldScheduleLegacyRecoverable({callingMode:false}),true);

assert.equal(shouldCircuitBreakSource({attempts:1200,hits:0,adapterVersion:"v1",currentVersion:"v1"}),true);
assert.equal(shouldCircuitBreakSource({attempts:3401,hits:8,adapterVersion:"v1",currentVersion:"v1"}),true);
assert.equal(shouldCircuitBreakSource({attempts:1258,hits:533,adapterVersion:"v1",currentVersion:"v1"}),false);
assert.equal(shouldCircuitBreakSource({attempts:3401,hits:8,adapterVersion:"v1",currentVersion:"v2"}),false,"new adapter version gets a fresh chance");
assert.equal(shouldCircuitBreakSource({attempts:999,hits:0,adapterVersion:"v1",currentVersion:"v1"}),false,"do not circuit-break before sample threshold");

console.log("law lane-pressure tests passed");
