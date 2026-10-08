import assert from "node:assert/strict";
import { needsStrictOwnedWebsiteAudit, needsCallReadyOwnedWebsiteAudit } from "./strict-owned-website-gate.mjs";

assert.equal(needsStrictOwnedWebsiteAudit({
  website:"",
  emailSourceVerified:true,
  emails:["office@examplefirm.com"],
  attorneyCount:4,
  attorneyCountVerified:true
}),true,"final strict candidate must get an owned-site audit before eligibility");

assert.equal(needsCallReadyOwnedWebsiteAudit({
  website:"",
  phone:"3125551212",
  attorneyCount:4,
  attorneyCountVerified:true,
  noOwnedWebsiteVerified:false
}),true,"verified 2-10 callable candidate must get site audit even without email");

assert.equal(needsCallReadyOwnedWebsiteAudit({
  website:"",
  phone:"3125551212",
  attorneyCount:4,
  attorneyCountVerified:true,
  noOwnedWebsiteVerified:true
}),false,"already-audited no-site lead must not repeat the audit");

assert.equal(needsCallReadyOwnedWebsiteAudit({
  website:"https://examplefirm.com",
  phone:"3125551212",
  attorneyCount:4,
  attorneyCountVerified:true,
  noOwnedWebsiteVerified:false
}),false,"known owned website does not need a no-site audit");

assert.equal(needsCallReadyOwnedWebsiteAudit({
  website:"",
  phone:"3125551212",
  attorneyCount:1,
  attorneyCountVerified:true,
  noOwnedWebsiteVerified:false
}),false,"wrong-size lead must not consume call-ready website audit");

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
}),false,"unverified email is not a final strict candidate");

assert.equal(needsStrictOwnedWebsiteAudit({
  website:"",
  emailSourceVerified:true,
  emails:["office@examplefirm.com"],
  attorneyCount:1,
  attorneyCountVerified:true
}),false,"wrong-size firms are not final strict candidates");

console.log("strict owned-website gate tests passed");
