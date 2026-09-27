import { createClient } from 'redis';
import { mergeLeadRecords } from './acquisition-persistence.mjs';
import { isCoreHomeServiceLead } from './home-service-targeting.mjs';
import { discoverContactUrls } from './email-contact-links.mjs';
import { buildLookupPlan } from './email-lookup-plan.mjs';
import {
  candidateEmailsFromEvidence,
  searchQueries,
  hostOf,
  platformDomain,
  businessTokenScore,
  normalizePhone,
  normalizeText,
  compactLocation,
} from './email-enrichment-evidence.mjs';

const REDIS_URL=process.env.ACQUISITION_REDIS_URL||'';
const YOZH_BASE_URL=(process.env.YOZH_BASE_URL||'').replace(/\/$/,'');
const CONCURRENCY=Math.max(1,Math.min(8,Number(process.env.EMAIL_V2_CONCURRENCY||3)));
const SEARCH_LIMIT=Math.max(4,Math.min(10,Number(process.env.EMAIL_V2_SEARCH_LIMIT||8)));
const QUERY_BUDGET=Math.max(1,Math.min(9,Number(process.env.EMAIL_V2_QUERY_BUDGET||2)));
const ENGINES=String(process.env.EMAIL_V2_ENGINES||'bing,yandex').split(',').map(x=>x.trim()).filter(Boolean).slice(0,2);
const RETRY_MS=Math.max(30*60*1000,Number(process.env.EMAIL_V2_RETRY_MS||6*60*60*1000));
const REFRESH_MS=Math.max(60*1000,Number(process.env.EMAIL_V2_REFRESH_MS||10*60*1000));
const LOOP_MS=Math.max(750,Number(process.env.EMAIL_V2_LOOP_MS||1500));
const STRATEGY_VERSION=String(process.env.EMAIL_V2_STRATEGY_VERSION||'v3-directory-staged');
const PENDING=`recover:secondary:email-v2:pending:${STRATEGY_VERSION}`;
const ATTEMPTED=`recover:secondary:email-v2:attempted:${STRATEGY_VERSION}`;
const LEADER=String(process.env.EMAIL_V2_LEADER_KEY||'recover:secondary:email-v2:leader');
if(!REDIS_URL) throw new Error('ACQUISITION_REDIS_URL required');
if(!YOZH_BASE_URL) throw new Error('YOZH_BASE_URL required');

const redis=createClient({url:REDIS_URL});
redis.on('error',e=>console.error('email-v2 redis error',e));
await redis.connect();
const INSTANCE=process.env.RAILWAY_REPLICA_ID||process.env.HOSTNAME||Math.random().toString(36).slice(2);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function acquireLeader(){return (await redis.set(LEADER,INSTANCE,{NX:true,EX:45}))==='OK';}
async function renewLeader(){if(await redis.get(LEADER)!==INSTANCE)return false;await redis.expire(LEADER,45);return true;}
if(!await acquireLeader()){
  console.log(JSON.stringify({event:'email_v2_standby',instance:INSTANCE}));
  while(true){await sleep(15000);if(await acquireLeader())break;}
}
setInterval(()=>renewLeader().catch(()=>{}),15000).unref();

function leadEmails(lead={}){
  const values=[...(Array.isArray(lead.emails)?lead.emails:[]),...String(lead.email||'').split(/[;,\s]+/)];
  return [...new Set(values.map(x=>String(x||'').trim().toLowerCase()).filter(Boolean))];
}
function leadLocation(lead={}){
  const city=String(lead.city||'').trim(), region=String(lead.region||lead.state||'').trim();
  if(city||region)return compactLocation([city,region].filter(Boolean).join(' '));
  return compactLocation(String(lead.address||lead.acquisition_location||'').trim());
}
function resultUrl(result={}){
  for(const v of [result.url,result.link,result.href,result.target_url,result.destination_url,result.canonical_url]){
    const s=String(v||'').trim(); if(/^https?:\/\//i.test(s))return s;
  }
  return '';
}
function resultText(result={}){return [result.title,result.snippet].filter(Boolean).join('\n');}
async function fetchJson(url,init={},timeout=90000){
  const ctl=new AbortController();const timer=setTimeout(()=>ctl.abort(),timeout);
  try{const r=await fetch(url,{...init,signal:ctl.signal});const text=await r.text();let body={};try{body=text?JSON.parse(text):{};}catch{body={raw:text};}if(!r.ok)throw new Error(`${r.status} ${r.statusText}: ${text.slice(0,300)}`);return body;}finally{clearTimeout(timer);}
}
async function search(query,engine){
  const body=await fetchJson(`${YOZH_BASE_URL}/api/v1/search`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query,engine,locale:'us',limit:SEARCH_LIMIT,scrape:false,proxy_type:'none',max_retries:0})},30000);
  return Array.isArray(body.results)?body.results:[];
}
async function scrapePages(results=[]){
  const chosen=results.map(r=>({...r,url:resultUrl(r)})).filter(r=>r.url).slice(0,1);
  if(!chosen.length)return [];
  const create=await fetchJson(`${YOZH_BASE_URL}/api/v1/scrape/pages`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pages:chosen.map(r=>({url:r.url,proxy_type:'none',raw_html:true,formats:['markdown'],timeout_ms:15000}))})},20000);
  const id=String(create?.job_id||''); if(!id)return chosen;
  const deadline=Date.now()+25000;let snap=null;
  while(Date.now()<deadline){snap=await fetchJson(`${YOZH_BASE_URL}/api/v1/scrape/${encodeURIComponent(id)}/results`,{},15000);if(Number(snap?.done||0)>=Number(snap?.total||chosen.length)||['completed','failed','cancelled','canceled'].includes(String(snap?.status||'').toLowerCase()))break;await sleep(1000);}
  const out=Array.isArray(snap?.results)?snap.results:[];
  return chosen.map((r,i)=>({...r,scrape:out[i]||null}));
}

let lastRefresh=0;
async function refreshPending({force=false}={}){
  if(!force&&Date.now()-lastRefresh<REFRESH_MS)return;
  lastRefresh=Date.now();const now=Date.now();const attempted=await redis.hGetAll(ATTEMPTED);let scanned=0,queued=0,withEmail=0,usableTargetEmail=0,emailNonTarget=0,withWebsite=0,noPhone=0,nonTarget=0,batch=[];
  for await(const page of redis.hScanIterator('recover:leadstore:qualified',{COUNT:500})){
    for(const entry of (Array.isArray(page)?page:[page])){
      if(!entry?.field||entry.value===undefined)continue; scanned++;
      let lead;try{lead=JSON.parse(entry.value)||{};}catch{continue;}
      if(leadEmails(lead).length){withEmail++;if(isCoreHomeServiceLead(lead))usableTargetEmail++;else emailNonTarget++;continue;}
      if(!isCoreHomeServiceLead(lead)){nonTarget++;continue;}
      if(String(lead.website||'').trim())withWebsite++;
      const phone=normalizePhone(lead.phone), business=String(lead.name||lead.title||'').trim(), location=leadLocation(lead);
      if(phone.length!==10){noPhone++;if(!business||!location)continue;}
      const last=Number(attempted?.[entry.field]||0);if(last&&now-last<RETRY_MS)continue;
      batch.push(entry.field);
      if(batch.length>=500){queued+=Number(await redis.sAdd(PENDING,batch)||0);batch=[];}
    }
  }
  if(batch.length)queued+=Number(await redis.sAdd(PENDING,batch)||0);
  console.log(JSON.stringify({event:'email_v2_pending_refresh',scanned,withEmail,usableTargetEmail,emailNonTarget,withWebsite,noPhone,nonTarget,queued,pending:await redis.sCard(PENDING)}));
}

function promisingResult(result,business,phone,location){
  const url=resultUrl(result);if(!url)return false;
  const text=resultText(result);const h=hostOf(url);
  const exactPhone=Boolean(normalizePhone(phone) && String(text).replace(/\D/g,'').includes(normalizePhone(phone)));
  const score=businessTokenScore(text,business);
  const locationToken=normalizeText(location).split(' ').find(x=>x.length>=3)||'';
  const locationMatch=locationToken&&normalizeText(text).includes(locationToken);
  return platformDomain(h)||exactPhone||score>=0.6||(score>=0.45&&locationMatch);
}

async function enrichOne(){
  await refreshPending();
  const key=String(await redis.sPop(PENDING)||'');if(!key)return {ran:false};
  const raw=await redis.hGet('recover:leadstore:qualified',key);if(!raw)return {ran:false};
  let lead;try{lead=JSON.parse(raw)||{};}catch{return {ran:false};}
  if(leadEmails(lead).length)return {ran:false};
  if(!isCoreHomeServiceLead(lead)){await redis.hSet(ATTEMPTED,key,String(Date.now()));return {ran:false,reason:'non_target'};}
  const phone=normalizePhone(lead.phone), business=String(lead.name||lead.title||'').trim(), location=leadLocation(lead);
  if(!business||(phone.length!==10&&!location))return {ran:false};
  const noWebsite=!String(lead.website||'').trim();
  const plan=buildLookupPlan({business,phone,location,address:String(lead.address||''),noWebsite});
  const queries=[...plan.stage1,...plan.stage2].slice(0,QUERY_BUDGET);
  const seen=new Set();let found=[],source='',rawResults=0,promising=0,enginesTried=0;
  try{
    const directUrl=String(lead.website||lead.social_profile_url||lead.profile_url||'').trim();
    if(/^https?:\/\//i.test(directUrl)){
      const direct=await scrapePages([{url:directUrl}]);
      for(const result of direct){
        const page=[resultText(result),result?.scrape?.markdown,result?.scrape?.fit_markdown,result?.scrape?.raw_html,result?.scrape?.html].filter(Boolean).join('\n');
        const emails=candidateEmailsFromEvidence({text:page,sourceUrl:directUrl,business,phone,location});
        if(emails.length){found.push(...emails);source=directUrl;}
        if(!emails.length){
          const contactUrls=discoverContactUrls(result).slice(0,1);
          if(contactUrls.length){
            const contactPages=await scrapePages(contactUrls.map(url=>({url})));
            for(const contact of contactPages){
              const contactText=[resultText(contact),contact?.scrape?.markdown,contact?.scrape?.fit_markdown,contact?.scrape?.raw_html,contact?.scrape?.html].filter(Boolean).join('\n');
              const more=candidateEmailsFromEvidence({text:contactText,sourceUrl:contact.url,business,phone,location});
              if(more.length){found.push(...more);source=source||contact.url;}
            }
          }
        }
      }
      found=[...new Set(found)];
    }
    for(const engine of ENGINES){
      if(found.length)break;
      enginesTried++;
      for(const query of queries){
        const results=await search(query,engine);rawResults+=results.length;
        const freshUrls=new Set();
        for(const result of results){
          const url=resultUrl(result);if(!url||seen.has(url))continue;seen.add(url);freshUrls.add(url);
          const snippetEmails=candidateEmailsFromEvidence({text:resultText(result),sourceUrl:url,business,phone,location});
          if(snippetEmails.length){found.push(...snippetEmails);source=source||url;}
        }
        found=[...new Set(found)];if(found.length)break;
        const candidates=results.filter(r=>promisingResult(r,business,phone,location)).filter(r=>{const u=resultUrl(r);return u&&freshUrls.has(u);}).slice(0,1);
        promising+=candidates.length;
        const scraped=await scrapePages(candidates);
        for(const result of scraped){
          const page=[resultText(result),result?.scrape?.markdown,result?.scrape?.fit_markdown,result?.scrape?.raw_html,result?.scrape?.html].filter(Boolean).join('\n');
          const emails=candidateEmailsFromEvidence({text:page,sourceUrl:result.url,business,phone,location});
          if(emails.length){found.push(...emails);source=source||result.url;continue;}
          const contactUrls=discoverContactUrls(result).slice(0,1);
          if(contactUrls.length){
            const contactPages=await scrapePages(contactUrls.map(url=>({url})));
            for(const contact of contactPages){
              const contactText=[resultText(contact),contact?.scrape?.markdown,contact?.scrape?.fit_markdown,contact?.scrape?.raw_html,contact?.scrape?.html].filter(Boolean).join('\n');
              const more=candidateEmailsFromEvidence({text:contactText,sourceUrl:contact.url,business,phone,location});
              if(more.length){found.push(...more);source=source||contact.url;}
            }
          }
        }
        found=[...new Set(found)];if(found.length)break;
      }
      if(found.length)break;
    }
  }catch(error){await redis.sAdd(PENDING,key);await redis.hIncrBy('recover:secondary:email-v2:stats','errors',1);throw error;}
  await redis.hSet(ATTEMPTED,key,String(Date.now()));
  if(!found.length){await redis.hIncrBy('recover:secondary:email-v2:stats','no_email',1);console.log(JSON.stringify({event:'email_v2_cycle',key,business,phone,queries:queries.length,engines:enginesTried,raw_results:rawResults,promising,emails:0}));return {ran:true,enriched:false};}
  const latestRaw=await redis.hGet('recover:leadstore:qualified',key);let latest=lead;try{if(latestRaw)latest=JSON.parse(latestRaw)||lead;}catch{}
  if(leadEmails(latest).length)return {ran:true,enriched:false,reason:'resolved_by_other_lane'};
  const merged=mergeLeadRecords(latest,{emails:found,source_email_enrichment:'multi_engine_public_evidence_v2',email_source_url:source,email_enriched_at:new Date().toISOString()});
  await redis.hSet('recover:leadstore:qualified',key,JSON.stringify(merged));
  await redis.hIncrBy('recover:secondary:email-v2:stats','enriched',found.length);
  console.log(JSON.stringify({event:'email_v2_cycle',key,business,phone,queries:queries.length,engines:enginesTried,raw_results:rawResults,promising,emails:found.length,source}));
  return {ran:true,enriched:true,emails:found.length};
}

await refreshPending({force:true});
console.log(JSON.stringify({event:'email_v2_started',strategy_version:STRATEGY_VERSION,concurrency:CONCURRENCY,pending:await redis.sCard(PENDING),retry_ms:RETRY_MS}));
while(true){
  try{const batch=await Promise.allSettled(Array.from({length:CONCURRENCY},()=>enrichOne()));const enriched=batch.filter(x=>x.status==='fulfilled'&&x.value?.enriched).length;const rejected=batch.filter(x=>x.status==='rejected').length;console.log(JSON.stringify({event:'email_v2_batch',concurrency:CONCURRENCY,enriched,rejected,pending:await redis.sCard(PENDING)}));}
  catch(error){console.error('email-v2 loop error',error?.message||error);}
  await sleep(LOOP_MS);
}
