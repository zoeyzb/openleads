import assert from "node:assert/strict";
import { alignEligibleToReady } from "./law-eligible-set-align.mjs";

const calls=[];
const redis={
  async sInterStore(destination,keys){calls.push({op:"sInterStore",destination,keys});return 3;},
  async del(){calls.push({op:"del"});throw new Error("alignment must not delete the live eligible set");}
};

const count=await alignEligibleToReady(redis,{
  eligibleSet:"eligible",
  readySet:"ready"
});
assert.equal(count,3);
assert.deepEqual(calls,[{op:"sInterStore",destination:"eligible",keys:["eligible","ready"]}]);
console.log("law eligible set alignment tests passed");
