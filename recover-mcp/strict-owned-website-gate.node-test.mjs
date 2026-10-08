import assert from "node:assert/strict";
import { needsStrictOwnedWebsiteAudit, needsCallReadyOwnedWebsiteAudit, noOwnedWebsiteAuditOutcome, hasCompletedSiteSearch } from "./strict-owned-website-gate.mjs";

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

assert.equal(noOwnedWebsiteAuditOutcome({
  ownedWebsite:"https://firm.example",checksSucceeded:1,checksFailed:2
}),"owned_site","known owned site is never eligible, even if other checks failed");
assert.equal(noOwnedWebsiteAuditOutcome({
  ownedWebsite:"",checksSucceeded:4,checksFailed:0
}),"no_site_audited","all successful, negative checks permit bounded no-site audit");
assert.equal(noOwnedWebsiteAuditOutcome({
  ownedWebsite:"",checksSucceeded:3,checksFailed:1
}),"inconclusive","failed site lookup must never be treated as a negative");
assert.equal(noOwnedWebsiteAuditOutcome({
  ownedWebsite:"",checksSucceeded:0,checksFailed:4
}),"inconclusive","complete source outage must never certify no site");
assert.equal(noOwnedWebsiteAuditOutcome({
  ownedWebsite:"",checksSucceeded:0,checksFailed:0
}),"inconclusive","missing audit evidence must never certify no site");

assert.equal(hasCompletedSiteSearch([
  {status:"fulfilled",value:{responded:false,links:[]}},
  {status:"rejected",reason:new Error("timeout")}
]),false,"failed and empty search providers cannot establish a negative site audit");
assert.equal(hasCompletedSiteSearch([
  {status:"fulfilled",value:{responded:true,links:[]}}
]),true,"an actual search response without firm-owned results can support a bounded negative audit");
console.log("strict owned-website gate tests passed");
