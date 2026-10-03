import assert from "node:assert/strict";
import { buildTargetHeadcountQueries } from "./headcount-search-plan.mjs";

const q=buildTargetHeadcountQueries({
  name:"Smith & Jones Law PLLC",
  phone:"(312) 555-1212",
  city:"Chicago",
  state:"IL"
});
assert.equal(q.length,6);
assert.ok(q[0].includes("site:martindale.com/organization"));
assert.ok(q[0].includes("312-555-1212"));
assert.ok(q.some(x=>x.includes('site:lawyer.com "312-555-1212" "Firm Size"')));
assert.ok(q.some(x=>x.includes('"Smith & Jones Law PLLC" Chicago IL "Firm Size"')));

console.log("headcount search plan tests passed");
