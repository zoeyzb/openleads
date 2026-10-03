import assert from "node:assert/strict";
import {isLawFirmLead,scoreLawFirmLead,lawFirmPracticeAreas,matchesLawPractice,qualifiesNoWebsiteLawLead,qualifiesEmailReadyNoWebsiteLawLead,shouldPauseLawDiscovery,lawResearchQueries,isUsableLawEmail,isPreferredLawFirmSize} from "./law-firm-targeting.mjs";

assert.equal(isLawFirmLead({category:"Personal injury attorney",name:"Smith & Doe Law"}),true);
assert.equal(isLawFirmLead({category:"Criminal defense attorney",name:"Jones Defense Law"}),true);
assert.equal(isLawFirmLead({category:"Divorce attorney",name:"Miller Family Law"}),true);
assert.equal(isLawFirmLead({category:"Bail bonds service",name:"Fast Bail"}),false);
assert.equal(isLawFirmLead({category:"Attorney",name:"County Prosecuting Attorney"}),false);
assert.equal(isLawFirmLead({category:"Attorney",name:"Chapter 13 Trustee"}),false);

assert.deepEqual(lawFirmPracticeAreas("Personal injury car accident law firm"),["personal injury"]);
assert.deepEqual(lawFirmPracticeAreas("Divorce and child custody attorney"),["family/divorce"]);
assert.deepEqual(lawFirmPracticeAreas("DUI and criminal defense lawyer"),["criminal defense"]);
assert.equal(matchesLawPractice("DUI criminal defense lawyer","criminal_defense"),true);
assert.equal(matchesLawPractice("Estate planning attorney","personal_injury"),false);

const scored=scoreLawFirmLead(
  {category:"Personal injury attorney",name:"Miller Law Firm",phone:"3125551212",website:"",review_count:40,rating:4.8},
  {practice_focus:"personal_injury"}
);
assert.ok(scored.score>=70);
assert.ok(scored.practice_areas.includes("personal injury"));
console.log("law-firm-targeting tests passed");

assert.equal(isPreferredLawFirmSize(1),false);
assert.equal(isPreferredLawFirmSize(2),true);
assert.equal(isPreferredLawFirmSize(10),true);
assert.equal(isPreferredLawFirmSize(11),false);

const qualifiedBase={
  website:"",
  emails:["realfirm@gmail.com"],
  practice_keys:["personal_injury"],
  attorney_count_estimate:4,
  attorney_count_evidence_verified:true,
  email_source_verified:true
};
assert.equal(qualifiesNoWebsiteLawLead({
  ...qualifiedBase,
  emails:[],
  email:"",
  email_source_verified:false,
  phone:"3125551212"
}),true,"eligible means callable + no owned website + verified 2-10; email is bonus");
assert.equal(qualifiesEmailReadyNoWebsiteLawLead(qualifiedBase),true);
assert.equal(qualifiesEmailReadyNoWebsiteLawLead({...qualifiedBase,emails:[],email:""}),false);
assert.equal(qualifiesNoWebsiteLawLead({...qualifiedBase,website:"https://example.com"}),false);
assert.equal(qualifiesNoWebsiteLawLead({...qualifiedBase,emails:[]}),false);
assert.equal(qualifiesNoWebsiteLawLead({...qualifiedBase,practice_keys:[]}),true);
assert.equal(qualifiesNoWebsiteLawLead({...qualifiedBase,attorney_count_estimate:1}),false);
assert.equal(qualifiesNoWebsiteLawLead({...qualifiedBase,attorney_count_estimate:11}),false);
assert.equal(qualifiesNoWebsiteLawLead({...qualifiedBase,email_source_verified:false}),false);
assert.equal(qualifiesNoWebsiteLawLead({...qualifiedBase,attorney_count_evidence_verified:false}),false);

assert.equal(shouldPauseLawDiscovery({pendingEnrichment:1500,limit:1000}),true);
assert.equal(shouldPauseLawDiscovery({pendingEnrichment:999,limit:1000}),false);

const researchQueries=lawResearchQueries({name:"Smith Law",city:"Dallas",region:"TX",phone:"2145551212"});
assert.ok(researchQueries.length>=2);
assert.ok(researchQueries.some(q=>q.includes("email")));
assert.ok(researchQueries.some(q=>q.includes("practice")));

const addressOnlyQueries=lawResearchQueries({
  name:"Hussmann Rogers Law LLC",
  address:"48 N Vermilion St, Danville, IL 61832",
  phone:"2174469436"
});
assert.ok(addressOnlyQueries.some(q=>q.includes("Danville IL email")),"address-only leads must recover city/state for exact firm email queries");
assert.ok(addressOnlyQueries.some(q=>q.includes("IL state bar email")),"address-only leads must recover state for bar queries");

assert.equal(isUsableLawEmail("realfirm@gmail.com"),true);
assert.equal(isUsableLawEmail("info@smithlaw.com"),true);
assert.equal(isUsableLawEmail("error-lite+9c39@duckduckgo.com"),false);
assert.equal(isUsableLawEmail("37798@attorneyyellowpages.com"),false);
assert.equal(isUsableLawEmail("jane.doe@ballardlaw.com"),false);
assert.equal(isUsableLawEmail("jdoe@potterlawoffices.com"),false);
assert.equal(isUsableLawEmail("your@email.com"),false);
assert.equal(isUsableLawEmail("flast@therogerslawgroup.com"),false);
assert.equal(isUsableLawEmail("info@thesunfirm.complease"),false);

assert.equal(qualifiesNoWebsiteLawLead({
  ...qualifiedBase,
  emails:["error-lite+9c39@duckduckgo.com"]
}),false);
