import assert from "node:assert/strict";
import { needsStrictOwnedWebsiteAudit } from "./strict-owned-website-gate.mjs";

assert.equal(needsStrictOwnedWebsiteAudit({
  website:"",
  emailSourceVerified:true,
  emails:["office@examplefirm.com"],
  attorneyCount:4,
  attorneyCountVerified:true
}),true,"final strict candidate must get an owned-site audit before eligibility");

assert.equal(needsStrictOwnedWebsiteAudit({
  website:"https://examplefirm.com",
  emailSourceVerified:true,
  emails:["office@examplefirm.com"],
  attorneyCount:4,
  attorneyCountVerified:true
}),false,"known website already fails the no-site gate");

assert.equal(needsStrictOwnedWebsiteAudit({
  website:"",
  emailSourceVerified:false,
  emails:["office@examplefirm.com"],
  attorneyCount:4,
  attorneyCountVerified:true
}),false,"unverified email is not a final eligibility candidate");

assert.equal(needsStrictOwnedWebsiteAudit({
  website:"",
  emailSourceVerified:true,
  emails:["office@examplefirm.com"],
  attorneyCount:1,
  attorneyCountVerified:true
}),false,"wrong-size firms are not final eligibility candidates");

console.log("strict owned-website gate tests passed");
