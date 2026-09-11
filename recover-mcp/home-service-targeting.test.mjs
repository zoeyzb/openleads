import test from "node:test";
import assert from "node:assert/strict";
import { isCoreHomeServiceLead } from "./home-service-targeting.mjs";

test("accepts core home-service businesses",()=>{
  assert.equal(isCoreHomeServiceLead({name:"Smith Heating & Cooling",category:"HVAC contractor"}),true);
  assert.equal(isCoreHomeServiceLead({name:"Jones Plumbing",category:"Plumber"}),true);
  assert.equal(isCoreHomeServiceLead({name:"Cold Chain Service",category:"Refrigeration contractor"}),true);
});

test("rejects adjacent construction and non-service junk even with plumbing/HVAC words",()=>{
  for(const lead of [
    {name:"Ryflo Plumbing and Construction LLC",category:"Plumber"},
    {name:"ABC HVAC Roofing",category:"HVAC contractor"},
    {name:"Home Depot AC Repair",category:"Air conditioning repair service"},
    {name:"United Rentals Power & HVAC",category:"HVAC contractor"},
    {name:"Landscape Heating Supply",category:"Heating contractor"},
  ]) assert.equal(isCoreHomeServiceLead(lead),false,lead.name);
});
