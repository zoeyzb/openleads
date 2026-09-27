import assert from 'node:assert/strict';
import { candidateEmailsFromEvidence, searchQueries } from './email-enrichment-evidence.mjs';

assert.deepEqual(
  candidateEmailsFromEvidence({
    text:'Acme Heating LLC, Aurora IL. Call (630) 555-1212. Email service@acmeheating.com',
    sourceUrl:'https://acmeheating.com/contact',
    business:'Acme Heating LLC',
    phone:'6305551212',
    location:'Aurora IL'
  }),
  ['service@acmeheating.com'],
  'a business-domain email on the exact business page should be accepted'
);

assert.deepEqual(
  candidateEmailsFromEvidence({
    text:'Acme Heating LLC Aurora IL email support@yelp.com',
    sourceUrl:'https://www.yelp.com/biz/acme-heating',
    business:'Acme Heating LLC',
    phone:'',
    location:'Aurora IL'
  }),
  [],
  'directory-owned email must be rejected'
);

assert.deepEqual(
  candidateEmailsFromEvidence({
    text:'Acme Heating LLC serves Aurora IL. Email acmeheat@gmail.com',
    sourceUrl:'https://chamberofcommerce.com/acme-heating',
    business:'Acme Heating LLC',
    phone:'',
    location:'Aurora IL'
  }),
  ['acmeheat@gmail.com'],
  'business plus location evidence should work without a phone'
);
console.log('email enrichment evidence tests passed');


const prioritized=searchQueries({business:'Acme Heating LLC',phone:'6305551212',location:'Aurora IL'});
assert.match(prioritized[0],/email$/,'email lookup must be the first search intent');
assert.ok(prioritized.findIndex(q=>q.includes('6305551212'))>1,'phone lookup must be fallback identity evidence, not the primary search');
