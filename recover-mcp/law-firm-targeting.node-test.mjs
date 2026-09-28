import assert from "node:assert/strict";
import {isLawFirmLead,scoreLawFirmLead,lawFirmPracticeAreas,matchesLawPractice,qualifiesNoWebsiteLawLead} from "./law-firm-targeting.mjs";

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
  emails:["hello@example.com"],
  practice_keys:["personal_injury"],
  personalization_fact:""
}),true);

assert.equal(qualifiesNoWebsiteLawLead({
  website:"https://example.com",
  emails:["hello@example.com"],
  practice_keys:["personal_injury"]
}),false);

assert.equal(qualifiesNoWebsiteLawLead({
  website:"",
  emails:[],
  practice_keys:["personal_injury"]
}),false);

assert.equal(qualifiesNoWebsiteLawLead({
  website:"",
  emails:["hello@example.com"],
  practice_keys:[]
}),false);
