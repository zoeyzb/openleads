import assert from "node:assert/strict";
import { reconcileExportMetrics, dedupeCallReadyRowsByPhone } from "./law-sheet-metrics.mjs";

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
assert.equal(reconciled.callReadyTarget,198);
assert.equal(reconciled.eligible,198);
assert.equal(reconciled.emailReady,3);
assert.equal(reconciled.emailReadyRate,3/198);
assert.equal(reconciled.verifiedEmails,43);
assert.equal(reconciled.pendingSizeReady,189);
assert.equal(snapshot.strictEligible,2);

const duplicateRows=[
  {priority:90,identity:"7044824441",row:["(704) 482-4441","Flowers Fred A"]},
  {priority:70,identity:"7044824441",row:["(704) 482-4441","Martin Jr Thomas W"]},
  {priority:80,identity:"2079470191",row:["(207) 947-0191","Paine Lynch & Harris"]}
];
const deduped=dedupeCallReadyRowsByPhone(duplicateRows);
assert.equal(deduped.length,2,"same normalized business phone must export once");
assert.equal(deduped[0].row[1],"Flowers Fred A","highest-priority representative is preserved");
assert.equal(deduped[1].row[1],"Paine Lynch & Harris");

console.log("law sheet metrics tests passed");
