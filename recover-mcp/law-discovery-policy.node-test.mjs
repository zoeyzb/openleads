import assert from "node:assert/strict";

const mod=await import("./law-discovery-policy.mjs").catch(()=>({}));
assert.equal(typeof mod.shouldPauseGenericDiscovery,"function","discovery policy must exist");

assert.equal(mod.shouldPauseGenericDiscovery?.({unresolvedCallable:8470,rawQueue:0},{unresolvedThreshold:1000}),true);
assert.equal(mod.shouldPauseGenericDiscovery?.({unresolvedCallable:999,rawQueue:64},{unresolvedThreshold:1000,rawQueueHighWater:64}),true);
assert.equal(mod.shouldPauseGenericDiscovery?.({unresolvedCallable:200,rawQueue:5},{unresolvedThreshold:1000,rawQueueHighWater:64}),false);

console.log("law discovery policy tests passed");
