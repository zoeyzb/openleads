import assert from 'node:assert/strict';
import {buildIdentityIndex, chooseHistoricalMatch, normalizePhone, normalizeText, mapIdentityFromUrl} from './historical-email-match.mjs';

const live=[
 {key:'place:abc',lead:{name:'Acme Heating LLC',address:'123 Main St, Aurora, IL 60505',phone:'(630) 555-1212',place_id:'abc',google_maps_url:'https://www.google.com/maps?cid=111'}},
 {key:'phone:3125559999',lead:{name:'Best Plumbing',address:'77 Oak Ave, Chicago, IL',phone:'312-555-9999',google_maps_url:'https://maps.google.com/?cid=222'}},
 {key:'nameaddr:x',lead:{name:'North Shore HVAC',address:'9 Lake Rd, Evanston, IL',phone:'8475550000'}},
];
const index=buildIdentityIndex(live);
assert.equal(normalizePhone('+1 630 555 1212'),'6305551212');
assert.equal(normalizeText('Acme Heating, LLC'),'acme heating llc');
assert.equal(mapIdentityFromUrl('https://maps.google.com/?cid=222'),'cid:222');

let m=chooseHistoricalMatch({raw_lead_id:'r1',name:'Wrong',phone:'000',address:'Nope'},index,{rawLeadMap:new Map([['r1','place:abc']])});
assert.equal(m?.key,'place:abc');
assert.equal(m?.method,'raw_lead_id');

m=chooseHistoricalMatch({name:'Acme Heating LLC',phone:'6305551212',address:'Elsewhere'},index);
assert.equal(m?.key,'place:abc');
assert.equal(m?.method,'phone');

m=chooseHistoricalMatch({name:'Whatever',phone:'',address:'',maps_url:'https://maps.google.com/?cid=222'},index);
assert.equal(m?.key,'phone:3125559999');
assert.equal(m?.method,'maps');

m=chooseHistoricalMatch({name:'North Shore HVAC',phone:'',address:'9 Lake Road, Evanston, IL'},index);
assert.equal(m?.key,'nameaddr:x');
assert.equal(m?.method,'name_address');

m=chooseHistoricalMatch({name:'North Shore HVAC',phone:'',address:'99 Wrong St, Evanston, IL'},index);
assert.equal(m,null);

console.log('historical-email-match tests passed');
