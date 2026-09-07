import test from "node:test";
import assert from "node:assert/strict";
import { matchesRequestedLocation, upsertQualifiedLeads } from "./acquisition-persistence.mjs";

function lead(i, overrides={}) {
  return {
    name:`HVAC ${i}`,
    address:`${100+i} Main St, Albany, NY 12207`,
    city:"Albany",
    region:"NY",
    place_id:`place-${i}`,
    phone:`5185550${String(i).padStart(3,"0")}`,
    qualification:{ score:70 },
    ...overrides
  };
}

test("running acquisition persists all six qualified leads immediately", () => {
  const job={ status:"running", qualified_count:6, stored_count:0 };
  const qualified=Array.from({length:6},(_,i)=>lead(i+1));
  const persisted=upsertQualifiedLeads([],qualified);
  job.stored_count=persisted.length;

  assert.equal(job.status,"running");
  assert.equal(job.qualified_count,6);
  assert.equal(job.stored_count,6);
  assert.equal(persisted.length,6);
});

test("second round upserts without deleting round-one results", () => {
  const round1=Array.from({length:6},(_,i)=>lead(i+1));
  const round2=[
    lead(7),
    lead(8),
    lead(3,{ phone:"5189999999", qualification:{score:85} })
  ];
  const persisted=upsertQualifiedLeads(round1,round2);

  assert.equal(persisted.length,8);
  assert.ok(persisted.some(x=>x.place_id==="place-1"));
  assert.equal(persisted.find(x=>x.place_id==="place-3").phone,"5189999999");
  assert.equal(persisted.find(x=>x.place_id==="place-3").qualification.score,85);
});

test("duplicate place IDs do not create duplicate persisted rows", () => {
  const persisted=upsertQualifiedLeads(
    [lead(1)],
    [lead(1,{ name:"HVAC 1 updated" }), lead(2)]
  );
  assert.equal(persisted.length,2);
  assert.equal(persisted.filter(x=>x.place_id==="place-1").length,1);
  assert.equal(persisted.find(x=>x.place_id==="place-1").name,"HVAC 1 updated");
});

test("normalized domain and phone provide stable fallback identity", () => {
  const first=lead(1,{place_id:"",website:"https://www.example.com/",phone:"(518) 555-1212"});
  const updated=lead(2,{place_id:"",website:"example.com",phone:"518-555-1212",name:"Updated"});
  const persisted=upsertQualifiedLeads([first],[updated]);
  assert.equal(persisted.length,1);
  assert.equal(persisted[0].name,"Updated");
});

test("requested New York location rejects California leakage", () => {
  assert.equal(matchesRequestedLocation(lead(1),"New York"),true);
  assert.equal(matchesRequestedLocation(lead(2,{
    address:"200 Market St, San Francisco, CA 94105",
    city:"San Francisco",
    region:"CA"
  }),"New York"),false);
});

test("specific city plus region must match both", () => {
  assert.equal(matchesRequestedLocation(lead(1),"Albany, NY"),true);
  assert.equal(matchesRequestedLocation(lead(2,{
    address:"200 Main St, Buffalo, NY 14202",
    city:"Buffalo",
    region:"NY"
  }),"Albany, NY"),false);
});

test("missing location evidence is rejected instead of leaking into results", () => {
  assert.equal(matchesRequestedLocation(lead(1,{address:"",city:"",region:""}),"New York"),false);
});
