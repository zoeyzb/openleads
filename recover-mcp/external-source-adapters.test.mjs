import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSmartScraperCsv, normalizeOutscraperPayload } from "./external-source-adapters.mjs";

test("normalizes SmartScraper CSV",()=>{
  const csv='Business Name,Phone,Address,Website,Category,Rating,Review Count,Google Maps URL\nAcme HVAC,555-123-4567,"1 Main St, Chicago, IL",,HVAC contractor,4.8,23,https://maps.google.com/x';
  const [lead]=normalizeSmartScraperCsv(csv);
  assert.equal(lead.name,"Acme HVAC");
  assert.equal(lead.phone,"555-123-4567");
  assert.equal(lead.category,"HVAC contractor");
  assert.equal(lead.source,"smartscraper");
});

test("normalizes Outscraper payload",()=>{
  const rows=normalizeOutscraperPayload({data:[[{
    name:"Heat Co",full_address:"2 Main St, Dallas, TX",phone:"+1 555 000 0000",
    site:"https://heat.example",place_id:"abc",location_link:"https://maps.google.com/y",
    rating:4.9,reviews:41,type:"HVAC contractor"
  }]]});
  assert.equal(rows.length,1);
  assert.equal(rows[0].name,"Heat Co");
  assert.equal(rows[0].place_id,"abc");
  assert.equal(rows[0].source,"outscraper");
});
