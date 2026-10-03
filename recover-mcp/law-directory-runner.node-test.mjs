import assert from "node:assert/strict";
import { runBoundedDirectoryCandidates } from "./law-directory-runner.mjs";

let active=0,maxActive=0;
const seen=[];
const items=Array.from({length:12},(_,i)=>i+1);
const out=await runBoundedDirectoryCandidates(
  items,
  async value=>{
    active++; maxActive=Math.max(maxActive,active);
    try{
      if(value===5)await new Promise(()=>{});
      await new Promise(r=>setTimeout(r,8));
      seen.push(value);
      return value*2;
    } finally { active--; }
  },
  {concurrency:3,timeoutMs:35}
);

assert.ok(maxActive<=3,`concurrency exceeded: ${maxActive}`);
assert.equal(out.length,12);
assert.equal(out.filter(x=>x.status==="fulfilled").length,11);
assert.equal(out.filter(x=>x.status==="rejected").length,1);
assert.match(String(out[4].reason?.message||out[4].reason),/timed out/i);
assert.ok(seen.includes(12),"a hung candidate must not prevent later candidates from running");

console.log("law directory runner tests passed");
