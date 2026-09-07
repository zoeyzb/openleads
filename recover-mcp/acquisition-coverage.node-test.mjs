import test from "node:test";
import assert from "node:assert/strict";
import { qualificationProfile, coverageField, coverageBlocksReseed } from "./acquisition-coverage.mjs";

const base={industry:"HVAC",location:"Buffalo, NY",require_no_website:true,require_contact:true,require_phone:false,require_email:false,include_no_website:true,min_score:30};

test("same industry area and profile is stable",()=>{
  assert.equal(coverageField(base),coverageField({...base,industry:" hvac ",location:"Buffalo,   NY"}));
});
test("different industry does not block same area",()=>{
  assert.notEqual(coverageField(base),coverageField({...base,industry:"Dentist"}));
});
test("different qualification profile does not block same industry area",()=>{
  assert.notEqual(coverageField(base),coverageField({...base,require_no_website:false}));
});
test("active and terminal coverage block reseed",()=>{
  for (const status of ["scheduled","running","target_reached","exhausted"]) assert.equal(coverageBlocksReseed({status}),true);
  for (const status of ["failed","cancelled",""]) assert.equal(coverageBlocksReseed({status}),false);
});
test("profile records no website and contactability",()=>{
  const p=qualificationProfile(base);
  assert.match(p,/nw:1/); assert.match(p,/contact:1/); assert.match(p,/score:30/);
});
