import assert from "node:assert/strict";
import { buildLawEmailSearchQueries } from "./law-email-search-plan.mjs";

const attorneyQueries=[
  '"Jane Doe" TX attorney email',
  '"Jane Doe" TX state bar email',
  '"Jane Doe" email site:govinfo.gov'
];
const baseQueries=[
  '"Doe Law" Dallas TX email',
  '"214-555-1212" email'
];
const headcountQueries=[
  '"Doe Law" "Firm Size"',
  '"Doe Law" site:lawyers.com "Firm Size"'
];

const sizeReady=buildLawEmailSearchQueries({
  attorneyQueries,
  baseQueries,
  headcountQueries,
  sizeVerified:true,
  phoneReady:true,
  conversionHeadcountPriority:false,
  chicagoWebsiteBuild:false
});
assert.deepEqual(
  sizeReady.slice(0,3),
  attorneyQueries,
  "verified 2-10 leads must spend the first search wave on attorney/email evidence, not re-proving headcount"
);

const sizeUnknown=buildLawEmailSearchQueries({
  attorneyQueries,
  baseQueries,
  headcountQueries,
  sizeVerified:false,
  phoneReady:true,
  conversionHeadcountPriority:false,
  chicagoWebsiteBuild:false
});
assert.deepEqual(
  sizeUnknown.slice(0,2),
  headcountQueries,
  "callable leads with unknown size should still prove headcount first"
);

console.log("law email search plan tests passed");
