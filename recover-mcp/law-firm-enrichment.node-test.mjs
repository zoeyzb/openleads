import assert from "node:assert/strict";
import { lawFirmPracticeAreas } from "./law-firm-targeting.mjs";

function stripHtml(html=""){return String(html).replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/\s+/g," ").trim();}
function attorneyEstimate(html="",text=""){
  const raw=String(html||"");
  const urls=[...raw.matchAll(/href\s*=\s*["']([^"']*(?:attorney|lawyer|people|team|our-team|professionals)[^"']*)["']/gi)]
    .map(m=>m[1].replace(/[?#].*$/,"").replace(/\/$/,"")).filter(x=>x.length>3);
  const unique=[...new Set(urls)];
  const profileLike=unique.filter(x=>/(attorney|lawyer|professional)\//i.test(x)||/\/(people|team|our-team|professionals)\/[^/]+$/i.test(x));
  let estimate=profileLike.length;
  const plain=String(text||stripHtml(raw));
  const explicit=[
    ...plain.matchAll(/\b(?:team of|our team of|firm of|more than|over)\s+(\d{1,3})\s+(?:attorneys|lawyers)\b/gi),
    ...plain.matchAll(/\b(\d{1,3})\s+(?:attorneys|lawyers)\s+(?:serving|across|with|at|in)\b/gi)
  ].map(m=>Number(m[1])).filter(n=>n>0&&n<=500);
  if(explicit.length) estimate=Math.max(estimate,Math.min(...explicit));
  const headingNames=[...raw.matchAll(/<(?:h2|h3|h4|a)[^>]*>([^<]{2,80})<\/(?:h2|h3|h4|a)>/gi)]
    .map(m=>stripHtml(m[1]).trim())
    .filter(name=>/^[A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){1,3}$/.test(name));
  const uniqueNames=[...new Set(headingNames.map(x=>x.toLowerCase()))];
  if(/\b(attorney|lawyer|our team|meet the team|professionals)\b/i.test(plain)&&uniqueNames.length>=2&&uniqueNames.length<=50) estimate=Math.max(estimate,uniqueNames.length);
  return Math.min(100,estimate);
}
assert.equal(attorneyEstimate('<a href="/attorney/jane-doe">Jane Doe</a><a href="/attorney/john-smith">John Smith</a>'),2);
assert.equal(attorneyEstimate('',"Our team of 4 attorneys focuses on families."),4);
assert.equal(attorneyEstimate('<h2>Jane Doe</h2><h2>John Smith</h2>',"Meet the team of attorneys"),2);
assert.deepEqual(lawFirmPracticeAreas("Family law and estate planning"),["family law","estate planning"]);
console.log("law firm enrichment tests passed");
