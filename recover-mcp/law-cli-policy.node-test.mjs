import assert from "node:assert/strict";

const policy=await import("./law-cli-policy.mjs").catch(()=>({}));
assert.equal(typeof policy.readLawWorkerOptions,"function","portable run-mode parser must exist");
assert.equal(typeof policy.shouldRequeueLegacyEmail,"function","calling mode must not revive email recovery");
assert.equal(typeof policy.headcountTimeoutDisposition,"function","bounded timeout disposition must exist");

const daemon=policy.readLawWorkerOptions([],{});
assert.equal(daemon.mode,"daemon");
assert.equal(daemon.bootstrap,true);
assert.equal(daemon.discover,true);
assert.equal(daemon.batchSize,96);

const once=policy.readLawWorkerOptions(["--once"],{});
assert.deepEqual({
  mode:once.mode,
  bootstrap:once.bootstrap,
  discover:once.discover,
  batchSize:once.batchSize,
  concurrency:once.concurrency,
  auditBatchSize:once.auditBatchSize,
  auditConcurrency:once.auditConcurrency
},{mode:"once",bootstrap:false,discover:false,batchSize:8,concurrency:4,auditBatchSize:4,auditConcurrency:2});

const bootstrap=policy.readLawWorkerOptions(["--once","--bootstrap","--discover"],{LAW_CLI_BATCH_LIMIT:"6"});
assert.equal(bootstrap.bootstrap,true);
assert.equal(bootstrap.discover,true);
assert.equal(bootstrap.batchSize,6);

assert.equal(policy.shouldRequeueLegacyEmail({callingMode:true,legacyRecoveryPending:true}),false);
assert.equal(policy.shouldRequeueLegacyEmail({callingMode:false,legacyRecoveryPending:true}),true);

assert.deepEqual(
  policy.headcountTimeoutDisposition({attempts:0,currentVersion:"v7",attemptVersion:"v7",maxAttempts:2}),
  {nextAttempt:1,attemptVersion:"v7",retry:true}
);
assert.deepEqual(
  policy.headcountTimeoutDisposition({attempts:1,currentVersion:"v7",attemptVersion:"v7",maxAttempts:2}),
  {nextAttempt:2,attemptVersion:"v7",retry:false}
);
assert.deepEqual(
  policy.headcountTimeoutDisposition({attempts:15,currentVersion:"v8",attemptVersion:"v7",maxAttempts:2}),
  {nextAttempt:1,attemptVersion:"v8",retry:true}
);
assert.throws(()=>policy.readLawWorkerOptions(["--once","--unknown"],{}),/unknown/i);
assert.throws(()=>policy.readLawWorkerOptions(["--once","--bootstrap","--no-bootstrap"],{}),/conflict/i);
console.log("law CLI portability policy tests passed");
