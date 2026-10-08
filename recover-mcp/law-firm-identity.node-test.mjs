import assert from "node:assert/strict";

const mod=await import("./law-firm-identity.mjs").catch(()=>({}));
assert.equal(typeof mod.canonicalLawFirmKey,"function","canonical firm identity must exist");

const a={name:"Flowers Fred A",phone:"(704) 482-4441",address:"212 S Dekalb St, Shelby, NC"};
const b={name:"Martin Jr Thomas W",phone:"704-482-4441",address:"212 S Dekalb St, Shelby, NC"};
assert.equal(mod.canonicalLawFirmKey?.(a),mod.canonicalLawFirmKey?.(b),"same business phone must collapse to one firm");

const c={name:"Smith & Jones LLP",phone:"",address:"10 Main St, Austin, TX"};
const d={name:"Smith and Jones LLP",phone:"",address:"10 Main Street, Austin, TX"};
assert.equal(mod.canonicalLawFirmKey?.(c),mod.canonicalLawFirmKey?.(d),"name/address fallback should normalize obvious punctuation variants");

console.log("law firm identity tests passed");
