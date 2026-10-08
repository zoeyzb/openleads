import assert from "node:assert/strict";

const mod=await import("./law-call-ready-policy.mjs").catch(()=>({}));

assert.equal(typeof mod.callReadyQualificationState,"function","call-ready policy must exist");
assert.equal(typeof mod.headcountRetryDisposition,"function","headcount retry policy must exist");
assert.equal(typeof mod.shouldRecycleLegacyEmailRecovery,"function","legacy email recycle guard must exist");

const auditVersion="call-ready-site-v1";

assert.deepEqual(
  mod.callReadyQualificationState?.({
    usablePhone:true,
    attorneyCount:4,
    attorneyCountVerified:true,
    website:"",
    websiteAuditStatus:"",
    websiteAuditVersion:""
  },{auditVersion}),
  {callReady:false,needsWebsiteAudit:true,reason:"website_audit_required"}
);

assert.deepEqual(
  mod.callReadyQualificationState?.({
    usablePhone:true,
    attorneyCount:4,
    attorneyCountVerified:true,
    website:"",
    websiteAuditStatus:"no_owned_site",
    websiteAuditVersion:auditVersion
  },{auditVersion}),
  {callReady:true,needsWebsiteAudit:false,reason:"call_ready"}
);

assert.deepEqual(
  mod.callReadyQualificationState?.({
    usablePhone:true,
    attorneyCount:4,
    attorneyCountVerified:true,
    website:"https://examplefirm.com",
    websiteAuditStatus:"owned_site",
    websiteAuditVersion:auditVersion
  },{auditVersion}),
  {callReady:false,needsWebsiteAudit:false,reason:"owned_website"}
);

assert.deepEqual(
  mod.headcountRetryDisposition?.({
    phone_headcount_status:"unverified",
    phone_headcount_method_version:"v1",
    phone_headcount_attempts:1
  },{currentMethodVersion:"v1",maxAttempts:3}),
  {attempt:1,shouldRetry:true,exhausted:false}
);

assert.deepEqual(
  mod.headcountRetryDisposition?.({
    phone_headcount_status:"unverified",
    phone_headcount_method_version:"v1",
    phone_headcount_attempts:3
  },{currentMethodVersion:"v1",maxAttempts:3}),
  {attempt:3,shouldRetry:false,exhausted:true}
);

assert.deepEqual(
  mod.headcountRetryDisposition?.({
    phone_headcount_status:"unverified",
    phone_headcount_method_version:"old",
    phone_headcount_attempts:99
  },{currentMethodVersion:"v1",maxAttempts:3}),
  {attempt:0,shouldRetry:true,exhausted:false},
  "new method version resets retry budget"
);

assert.equal(
  mod.shouldRecycleLegacyEmailRecovery?.({lane:"general",lawEmailValidation:"recovery_pending",sizeReady:false}),
  false,
  "legacy email flags must never recycle the general phone/headcount worker"
);
assert.equal(
  mod.shouldRecycleLegacyEmailRecovery?.({lane:"size_ready",lawEmailValidation:"recovery_pending",sizeReady:true}),
  true,
  "explicit email bonus worker may use its own bounded retry"
);

console.log("law call-ready policy tests passed");
