import assert from 'node:assert/strict';
import {qualifiesCallReadyNoWebsiteLawLead,qualifiesEmailReadyNoWebsiteLawLead} from './law-firm-targeting.mjs';
import {needsStrictOwnedWebsiteAudit,needsCallReadyOwnedWebsiteAudit} from './strict-owned-website-gate.mjs';
for (const count of [undefined,0,1,11,1000]) {
  const lead={law_identity_verified:true,phone:'3125551212',no_owned_website_verified:true,email_source_verified:true,emails:['publishedfirm@gmail.com'],attorney_count_estimate:count};
  assert.equal(qualifiesCallReadyNoWebsiteLawLead(lead),true,`any-size call lane: ${count}`);
  assert.equal(qualifiesEmailReadyNoWebsiteLawLead(lead),true,`any-size strict lane: ${count}`);
  assert.equal(needsStrictOwnedWebsiteAudit({emailSourceVerified:true,emails:lead.emails,attorneyCount:count}),true);
  assert.equal(needsCallReadyOwnedWebsiteAudit({phone:lead.phone,attorneyCount:count}),true);
  assert.equal(qualifiesEmailReadyNoWebsiteLawLead({...lead,email_source_verified:false}),false);
  assert.equal(qualifiesCallReadyNoWebsiteLawLead({...lead,law_identity_verified:false}),false);
  assert.equal(qualifiesCallReadyNoWebsiteLawLead({...lead,no_owned_website_verified:false}),false);
}
console.log('any-size integration policy passed');

// Exercise the actual legacy directory-card extractor without starting Redis.
const {readFileSync}=await import('node:fs');
const vm=await import('node:vm');
const source=readFileSync(new URL('./law-firm-pipeline.mjs',import.meta.url),'utf8');
function body(name,next){return source.slice(source.indexOf(`function ${name}(`),source.indexOf(next,source.indexOf(`function ${name}(`)));}
const context=vm.createContext({
  stripHtml:s=>s.replace(/<[^>]*>/g,' '),
  absoluteLawyersUrl:s=>new URL(s,'https://www.lawyers.com').href,
  officialFirmSizeEstimate:s=>Number(s.match(/with (\d+) lawyers/)?.[1]||0),
  directoryCardWebsiteCandidate:()=>'',
  extractDirectoryPhone:s=>s.match(/312-422-1836/)?.[0]||'',
  normalizeLawPhone:s=>s.replace(/\D/g,''),
  normalize:s=>s.toLowerCase()
});
vm.runInContext(body('directoryCardFirmAnchor','\nfunction extractLawyersComDirectoryCandidates')+'\n'+body('extractLawyersComDirectoryCandidates','\nasync function verifyDirectoryCandidate'),context);
for(const size of ['', 'Law Firm with 1 lawyer', 'Law Firm with 200 lawyers']){
  const html=`<a href="https://www.lawyers.com/il/fixture/fixture-law-123-f/">Fixture Law</a> Call 312-422-1836 ${size}`;
  assert.equal(context.extractLawyersComDirectoryCandidates(html,'https://www.lawyers.com/il/fixture/',{state:'IL'}).length,1,`directory candidate survives optional size: ${size}`);
}
assert.doesNotMatch(source,/known_wrong_size_short_circuit|phone_first_wrong_size_short_circuit|if\(n<2\|\|n>10\)continue/);
console.log('any-size directory discovery passed');
