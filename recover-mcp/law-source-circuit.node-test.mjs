import assert from "node:assert/strict";

const mod=await import("./law-source-circuit.mjs").catch(()=>({}));
assert.equal(typeof mod.sourceCircuitState,"function","source circuit policy must exist");

assert.deepEqual(
  mod.sourceCircuitState?.({attempts:3083,hits:0},{minAttempts:250,minYield:0.005}),
  {enabled:false,yieldRate:0,reason:"low_yield"}
);
assert.deepEqual(
  mod.sourceCircuitState?.({attempts:1258,hits:533},{minAttempts:250,minYield:0.005}),
  {enabled:true,yieldRate:533/1258,reason:"productive"}
);
assert.deepEqual(
  mod.sourceCircuitState?.({attempts:20,hits:0},{minAttempts:250,minYield:0.005}),
  {enabled:true,yieldRate:0,reason:"insufficient_sample"}
);

console.log("law source circuit tests passed");
