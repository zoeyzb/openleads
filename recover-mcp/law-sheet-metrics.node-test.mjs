import assert from "node:assert/strict";
import { reconcileExportMetrics } from "./law-sheet-metrics.mjs";

const snapshot={
  strictEligible:2,
  callReady:197,
  verifiedEmails:43,
  verifiedHeadcounts:1801,
  pendingSizeReady:189,
  strictConversion:2/197,
  timestamp:"2026-10-02T18:37:00.000Z"
};

const reconciled=reconcileExportMetrics(snapshot,{strictRows:3,callReadyRows:198});

assert.equal(reconciled.strictEligible,3);
assert.equal(reconciled.callReady,198);
assert.equal(reconciled.callReadyTarget,198,"call-ready target must equal callable/no-site/verified-2-10 rows");
assert.equal(reconciled.eligible,198,"eligible must equal the callable no-site verified-2-10 cohort");
assert.equal(reconciled.emailReady,3,"email-ready remains the bonus source-verified-email subset");
assert.equal(reconciled.emailReadyRate,3/198);
assert.equal(reconciled.verifiedEmails,43);
assert.equal(reconciled.pendingSizeReady,189);
assert.equal(snapshot.strictEligible,2,"input snapshot must not be mutated");

console.log("law sheet metrics tests passed");
