import assert from "node:assert/strict";

const mod=await import("./law-set-claim.mjs").catch(()=>({}));
assert.equal(typeof mod.claimSetBatch,"function","destructive set claim helper must exist");

const members=new Set(["a","b","c"]);
const calls=[];
const redis={
  async sCard(){return members.size;},
  async sRandMemberCount(_key,count){return [...members].slice(0,count);},
  async sRem(_key,values){
    const list=Array.isArray(values)?values:[values];
    for(const value of list)members.delete(value);
    calls.push({op:"sRem",values:[...list]});
    return list.length;
  }
};
const claimed=await mod.claimSetBatch?.(redis,"queue",2);
assert.deepEqual(claimed,["a","b"]);
assert.deepEqual([...members],["c"],"claimed items must leave the source queue before work starts");
assert.deepEqual(calls,[{op:"sRem",values:["a","b"]}]);

console.log("law set claim tests passed");
