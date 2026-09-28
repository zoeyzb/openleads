import assert from "node:assert/strict";
import {isLawFirmLead,scoreLawFirmLead,lawFirmPracticeAreas,matchesLawPractice,qualifiesNoWebsiteLawLead,shouldPauseLawDiscovery,lawResearchQueries,isUsableLawEmail} from "./law-firm-targeting.mjs";

assert.equal(isLawFirmLead({category:"Personal injury attorney",name:"Smith & Doe Law"}),true);
assert.equal(isLawFirmLead({category:"Criminal defense attorney",name:"Jones Defense Law"}),true);
assert.equal(isLawFirmLead({category:"Divorce attorney",name:"Miller Family Law"}),true);
assert.equal(isLawFirmLead({category:"Bail bonds service",name:"Fast Bail"}),false);

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

assert.equal(qualifiesNoWebsiteLawLead({
  website:"",
  emails:["realfirm@gmail.com"],
  practice_keys:["personal_injury"],
  personalization_fact:""
}),true);

assert.equal(qualifiesNoWebsiteLawLead({
  website:"https://example.com",
  emails:["realfirm@gmail.com"],
  practice_keys:["personal_injury"]
}),false);

assert.equal(qualifiesNoWebsiteLawLead({
  website:"",
  emails:[],
  practice_keys:["personal_injury"]
}),false);

assert.equal(qualifiesNoWebsiteLawLead({
  website:"",
  emails:["realfirm@gmail.com"],
  practice_keys:[]
}),false);

assert.equal(shouldPauseLawDiscovery({pendingEnrichment:1500,limit:1000}),true);
assert.equal(shouldPauseLawDiscovery({pendingEnrichment:999,limit:1000}),false);

const researchQueries=lawResearchQueries({name:"Smith Law",city:"Dallas",region:"TX",phone:"2145551212"});
assert.ok(researchQueries.length>=2);
assert.ok(researchQueries.some(q=>q.includes("email")));
assert.ok(researchQueries.some(q=>q.includes("practice")));

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
  website:"",
  emails:["error-lite+9c39@duckduckgo.com"],
  practice_keys:["personal_injury"]
}),false);
