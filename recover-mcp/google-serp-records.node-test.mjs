import assert from "node:assert/strict";
import { googleResultRecords } from "./google-serp-records.mjs";

const html=`
<html><body>
  <div class="MjjYud">
    <div class="g">
      <a href="https://www.lawyers.com/all-legal-issues/chicago/illinois/law-firms/"><h3>Chicago Law Firms</h3></a>
      <div class="VwiC3b">Smith &amp; Jones Law PLLC Chicago IL Law Office with 4 lawyers Call 312-555-1212</div>
    </div>
  </div>
  <div class="MjjYud">
    <div class="g">
      <a href="/url?q=https%3A%2F%2Fwww.martindale.com%2Forganization%2Fsmith-jones-law-123%2F&sa=U"><h3>Smith &amp; Jones Law</h3></a>
      <div>Smith &amp; Jones Law PLLC — Firm Size: 4 — 312-555-1212</div>
    </div>
  </div>
</body></html>`;

const records=googleResultRecords(html);
assert.equal(records.length,2);
assert.equal(records[0].url,"https://www.lawyers.com/all-legal-issues/chicago/illinois/law-firms/");
assert.match(records[0].text,/Law Office with 4 lawyers/);
assert.match(records[0].text,/312-555-1212/);
assert.equal(records[1].url,"https://www.martindale.com/organization/smith-jones-law-123/");
assert.match(records[1].text,/Firm Size: 4/);

const unrelated=googleResultRecords(`
<div class="g"><a href="https://www.google.com/preferences">Prefs</a><div>Google settings</div></div>
<div class="g"><a href="javascript:void(0)">bad</a></div>
`);
assert.deepEqual(unrelated,[]);

console.log("google SERP record tests passed");
