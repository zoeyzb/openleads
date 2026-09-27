import assert from "node:assert/strict";
import {isLawFirmLead,isCriminalLawFirm,scoreLawFirmLead} from "./law-firm-targeting.mjs";

assert.equal(isLawFirmLead({category:"Personal injury attorney",name:"Smith & Doe Law"}),true);
assert.equal(isLawFirmLead({category:"Criminal justice attorney",name:"Jones Defense Law"}),false);
assert.equal(isCriminalLawFirm({category:"DUI attorney"}),true);
assert.equal(isLawFirmLead({category:"Bail bonds service",name:"Fast Bail"}),false);
const scored=scoreLawFirmLead({category:"Estate planning attorney",name:"Miller Law Firm",phone:"3125551212",website:"https://millerlaw.com",review_count:40,rating:4.8});
assert.ok(scored.score>=70);
assert.ok(scored.practice_areas.includes("estate planning"));
console.log("law-firm-targeting tests passed");
