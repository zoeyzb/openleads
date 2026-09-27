import assert from 'node:assert/strict';
import { candidateEmailsFromEvidence } from './email-enrichment-evidence.mjs';

const common={business:'Roman HVAC Chicago',phone:'8552349725',location:'Chicago IL'};
assert.deepEqual(candidateEmailsFromEvidence({
  ...common,
  text:'Roman HVAC Chicago 855-234-9725 info@romanhvac.com Chicago IL',
  sourceUrl:'https://www.yelp.com/biz/roman-hvac-chicago'
}),['info@romanhvac.com']);

assert.deepEqual(candidateEmailsFromEvidence({
  business:'Best Decision Heating and Cooling',phone:'9412766026',location:'Florida',
  text:'Best Decision Heating and Cooling 941-276-6026 help@mapquest.com Florida',
  sourceUrl:'https://www.mapquest.com/us/florida/best-decision-heating'
}),[]);

assert.deepEqual(candidateEmailsFromEvidence({
  business:'Tom’s Plumbing & Heating Services',phone:'9298883311',location:'Queens NY',
  text:'Tom’s Plumbing & Heating Services 929-888-3311 u002fffb96741d75652c5232f343ed4455fc9@o9737.ingest.us.sentry.io Queens NY',
  sourceUrl:'https://www.yelp.com/biz/toms-plumbing'
}),[]);

assert.deepEqual(candidateEmailsFromEvidence({
  business:'Stillhouse Heating Air Conditioning',phone:'9292989750',location:'Texas',
  text:'Stillhouse Heating Air Conditioning 929-298-9750 contact@rileys-hvac.com Texas',
  sourceUrl:'https://www.chamberofcommerce.com/business-directory/texas/stillhouse-heating'
}),[]);

console.log('strict email evidence tests passed');