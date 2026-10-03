import assert from "node:assert/strict";
import { trustedIndexedTargetHeadcount } from "./indexed-target-headcount.mjs";

const lead={name:"Smith & Jones Law PLLC",phone:"3125551212",city:"Chicago",region:"IL"};

assert.deepEqual(
  trustedIndexedTargetHeadcount([
    {url:"https://www.martindale.com/organization/smith-jones-law-123/",text:"Smith & Jones Law PLLC Chicago IL Firm Size: 4 Call 312-555-1212"}
  ],lead)?.count,
  4,
  "exact phone + firm-specific trusted profile may prove a positive 2-10 count"
);

assert.equal(
  trustedIndexedTargetHeadcount([
    {url:"https://www.martindale.com/organization/smith-jones-law-123/",text:"Smith & Jones Law PLLC Chicago IL Firm Size: 1 Call 312-555-1212"}
  ],lead),
  null,
  "indexed snippets must never be used to classify solos"
);

assert.equal(
  trustedIndexedTargetHeadcount([
    {url:"https://www.martindale.com/organization/smith-jones-law-123/",text:"Smith & Jones Law PLLC Chicago IL Firm Size: 4"}
  ],lead),
  null,
  "name+geo without phone needs independent host agreement"
);

assert.equal(
  trustedIndexedTargetHeadcount([
    {url:"https://www.martindale.com/organization/smith-jones-law-123/",text:"Smith & Jones Law PLLC Chicago IL Firm Size: 4"},
    {url:"https://www.lawyer.com/firm/smith-jones-law.html",text:"Smith & Jones Law PLLC Chicago IL Firm Size: 4"}
  ],lead)?.count,
  4,
  "two independent trusted hosts agreeing on the same target count may prove size"
);

assert.equal(
  trustedIndexedTargetHeadcount([
    {url:"https://www.martindale.com/organization/smith-jones-law-123/",text:"Smith & Jones Law PLLC Chicago IL Firm Size: 4"},
    {url:"https://www.lawyer.com/firm/smith-jones-law.html",text:"Smith & Jones Law PLLC Chicago IL Firm Size: 5"}
  ],lead),
  null,
  "conflicting indexed counts must be rejected"
);

assert.equal(
  trustedIndexedTargetHeadcount([
    {url:"https://www.lawyer.com/lawyers/chicago/illinois/",text:"Smith & Jones Law PLLC Chicago IL Firm Size: 4 Call 312-555-1212"}
  ],lead),
  null,
  "broad directory pages are not firm-specific evidence"
);

console.log("indexed target headcount tests passed");
