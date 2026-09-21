import { createClient } from "redis";
import { isCoreHomeServiceLead, isOwnedBusinessWebsite } from "./home-service-targeting.mjs";
import { campaignLeadSetKey } from "./acquisition-coverage.mjs";

const REDIS_URL=process.env.ACQUISITION_REDIS_URL||"";
const YOZH_BASE_URL=(process.env.YOZH_BASE_URL||"").replace(/\/$/,"");
const ZIP_SOURCE_URL=process.env.US_ZIP_SOURCE_URL||"https://raw.githubusercontent.com/ReadyAPIs-com/curated-us-zips/main/data/us-zips.csv";
const LOOP_MS=Math.max(1000,Number(process.env.SECONDARY_DISCOVERY_LOOP_MS||2500));
const SEARCH_LIMIT=Math.min(25,Math.max(5,Number(process.env.SECONDARY_DISCOVERY_SEARCH_LIMIT||12)));
const TARGET_TOTAL=Number(process.env.US_HVAC_TARGET_TOTAL||1000000);
if(!REDIS_URL) throw new Error("ACQUISITION_REDIS_URL required");
if(!YOZH_BASE_URL) throw new Error("YOZH_BASE_URL required");

const PROFILE_JOB={industry:"HVAC",search_profile:"core-home-service",require_contact:true,require_no_website:true,include_no_website:true,min_score:30};
const DIRECTORY_DOMAINS=["yellowpages.com","chamberofcommerce.com","manta.com","bbb.org","yelp.com","angi.com","homeadvisor.com","thumbtack.com","houzz.com","nextdoor.com","superpages.com","porch.com","buildzoom.com","facebook.com"];
const FAMILIES=[
  "HVAC contractor","heating contractor","air conditioning repair service","HVAC repair service",
  "HVAC maintenance","heating and cooling service","furnace repair service","boiler repair service",
  "heat pump contractor","ductless HVAC contractor","mini split installation service","air duct contractor",
  "ventilation contractor","indoor air quality service","thermostat installation service",
  "plumbing contractor","plumber","emergency plumber","plumbing repair service","water heater repair service",
  "water heater installation","drain cleaning service","sewer repair service","refrigeration contractor"
];

const redis=createClient({url:REDIS_URL});
redis.on("error",e=>console.error("Redis error",e));
await redis.connect();

const LEADER_KEY="recover:secondary:leader";
const INSTANCE_ID=process.env.RAILWAY_REPLICA_ID||process.env.HOSTNAME||Math.random().toString(36).slice(2);
async function acquireLeader(){
  const ok=await redis.set(LEADER_KEY,INSTANCE_ID,{NX:true,EX:45});
  return ok==="OK";
}
async function renewLeader(){
  const current=await redis.get(LEADER_KEY);
  if(current!==INSTANCE_ID) return false;
  await redis.expire(LEADER_KEY,45);
  return true;
}
if(!await acquireLeader()){
  console.log(JSON.stringify({event:"secondary_discovery_standby",instance:INSTANCE_ID}));
  while(true){
    await new Promise(r=>setTimeout(r,15000));
    if(await acquireLeader()) break;
  }
}
setInterval(()=>renewLeader().catch(()=>{}),15000).unref();

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function normalizeText(v=""){return String(v||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();}
function normalizePhone(v=""){return String(v||"").replace(/\D/g,"").slice(-10);}
function emailsFrom(text=""){return [...new Set((String(text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig)||[]).map(x=>x.toLowerCase()))];}
function phonesFrom(text=""){
  const out=[];
  for(const m of String(text).matchAll(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/g)){
    const p=normalizePhone(m[0]); if(p.length===10&&!out.includes(p)) out.push(p);
  }
  return out;
}
function hostOf(url=""){try{return new URL(url).hostname.toLowerCase().replace(/^www\./,"");}catch{return "";}}
function isDirectoryUrl(url=""){const h=hostOf(url);return DIRECTORY_DOMAINS.some(d=>h===d||h.endsWith("."+d));}
function explicitWebsiteFromHtml(html=""){
  const src=String(html||"");
  const patterns=[
    /<a\b[^>]*href=["'](https?:\/\/[^"'#]+)["'][^>]*>\s*(?:visit\s+)?website\s*<\/a>/ig,
    /<a\b[^>]*>\s*(?:visit\s+)?website\s*<\/a>/ig
  ];
  for(const re of patterns){
    const m=re.exec(src);
    if(m?.[1]&&isOwnedBusinessWebsite(m[1])) return m[1];
  }
  return "";
}
function cleanName(title=""){
  return String(title||"")
    .replace(/\s*[|–—-]\s*(?:Yellow Pages|Yelp|BBB|Better Business Bureau|Chamber of Commerce|Manta).*$/i,"")
    .replace(/\s*\|\s*.*$/,"").trim();
}
function locationMatches(text,city,state,url=""){
  const hay=normalizeText(text),c=normalizeText(city),s=normalizeText(state);
  const cityInText=Boolean(c&&hay.includes(c));
  const stateInText=Boolean(s&&new RegExp("\\b"+s+"\\b").test(hay));
  let cityInUrl=false;
  try{
    const u=new URL(url);
    const slug=normalizeText(u.pathname);
    cityInUrl=Boolean(c&&slug.includes(c));
  }catch{}
  return (cityInText&&stateInText) || cityInText || cityInUrl || stateInText;
}
function permanentKey(lead){
  const phone=normalizePhone(lead.phone||"");
  if(phone) return "phone:"+phone;
  const email=(lead.emails||[])[0]; if(email) return "email:"+String(email).toLowerCase();
  return "secondary:"+normalizeText((lead.name||"")+"|"+(lead.city||"")+"|"+(lead.region||""));
}
async function fetchJson(url,init={},timeout=90000){
  const ctl=new AbortController(); const timer=setTimeout(()=>ctl.abort(),timeout);
  try{
    const r=await fetch(url,{...init,signal:ctl.signal});
    const text=await r.text(); let body={}; try{body=text?JSON.parse(text):{}}catch{body={raw:text}}
    if(!r.ok) throw new Error(r.status+" "+r.statusText+": "+text.slice(0,300));
    return body;
  }finally{clearTimeout(timer);}
}
async function scrapeDirectoryProfiles(results=[]){
  const chosen=(results||[]).slice(0,SEARCH_LIMIT);
  if(!chosen.length) return [];
  const create=await fetchJson(`${YOZH_BASE_URL}/api/v1/scrape/pages`,{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({pages:chosen.map(r=>({url:r.url,proxy_type:"none",raw_html:true,formats:["markdown"],timeout_ms:30000}))})
  },30000);
  const jobId=String(create?.job_id||"");
  if(!jobId) return chosen;
  const deadline=Date.now()+70000;
  let snap=null;
  while(Date.now()<deadline){
    snap=await fetchJson(`${YOZH_BASE_URL}/api/v1/scrape/${encodeURIComponent(jobId)}/results`,{},30000);
    if(Number(snap?.done||0)>=Number(snap?.total||chosen.length)||["completed","failed","cancelled","canceled"].includes(String(snap?.status||"").toLowerCase())) break;
    await sleep(1200);
  }
  const scraped=Array.isArray(snap?.results)?snap.results:[];
  return chosen.map((r,i)=>({...r,scrape:scraped[i]||null}));
}

function parseCsv(text){
  const rows=[];let row=[],field="",quoted=false;
  for(let i=0;i<text.length;i++){const ch=text[i];
    if(quoted){if(ch==='"'&&text[i+1]==='"'){field+='"';i++;}else if(ch==='"')quoted=false;else field+=ch;}
    else if(ch==='"')quoted=true;else if(ch===','){row.push(field);field="";}else if(ch==='\n'){row.push(field);rows.push(row);row=[];field="";}else if(ch!=='\r')field+=ch;
  } if(field.length||row.length){row.push(field);rows.push(row);} if(!rows.length)return[];
  const headers=rows.shift().map(x=>x.trim().toLowerCase());
  return rows.map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]??""])));
}
async function loadCities(){
  const csv=await (await fetch(ZIP_SOURCE_URL)).text(); const rows=parseCsv(csv); const by=new Map();
  for(const r of rows){
    const city=String(r.city||r.primary_city||"").trim(),state=String(r.state||r.state_id||"").trim().toUpperCase();
    if(!city||!/^[A-Z]{2}$/.test(state)||["PR","VI","GU","AS","MP"].includes(state))continue;
    const pop=Number(String(r.population||"0").replace(/[^0-9.-]/g,""))||0,key=state+"|"+city;
    const cur=by.get(key)||{city,state,population:0};cur.population+=pop;by.set(key,cur);
  }
  return [...by.values()].filter(x=>x.population>=10000).sort((a,b)=>b.population-a.population||a.state.localeCompare(b.state)||a.city.localeCompare(b.city));
}
async function saveCandidate({result,city,state,family,domain}){
  if(!result?.url||!isDirectoryUrl(result.url)) return {accepted:false,reason:"not_directory"};
  const scrape=result.scrape||{};
  const page=[result.title,result.snippet,scrape.markdown,scrape.fit_markdown].filter(Boolean).join("\n");
  const locationOk=locationMatches(page,city,state,result.url);
  const owned=explicitWebsiteFromHtml(scrape.raw_html||scrape.html||"");
  if(owned) return {accepted:false,reason:"owned_website"};
  const phones=phonesFrom(page),emails=emailsFrom(page);
  if(!phones.length&&!emails.length) return {accepted:false,reason:"contact"};
  if(!locationOk&&!phones.length) return {accepted:false,reason:"location"};
  const lead={
    name:cleanName(result.title||""),
    category:"",
    description:[result.snippet,scrape.markdown].filter(Boolean).join(" ").slice(0,8000),
    address:"",
    city:locationOk?city:"",region:locationOk?state:"",website:"",
    social_profile_url:result.url,
    phone:phones[0]||"",emails,
    source:"secondary_directory_search",source_directory:domain,source_query_family:family,discovery_query_location:`${city}, ${state}`
  };
  if(!lead.name||!isCoreHomeServiceLead(lead)) return {accepted:false,reason:"industry"};
  const key=permanentKey(lead);
  const existing=await redis.hGet("recover:leadstore:qualified",key);
  if(existing) return {accepted:false,reason:"duplicate"};
  const stored={...lead,industry:"HVAC",campaign_scope:campaignLeadSetKey(PROFILE_JOB),persisted_at:new Date().toISOString(),qualification:{source:"secondary_directory_search",strict_core_home_service:true,no_owned_website:true,contactable:true}};
  await redis.hSet("recover:leadstore:qualified",key,JSON.stringify(stored));
  await redis.sAdd(campaignLeadSetKey(PROFILE_JOB),key);
  await redis.hIncrBy("recover:secondary:stats","new_qualified",1);
  return {accepted:true,key};
}

const cities=await loadCities();
let cursor=Number(await redis.get("recover:secondary:cursor")||0);
let familyCursor=Number(await redis.get("recover:secondary:family_cursor")||0);
let domainCursor=Number(await redis.get("recover:secondary:domain_cursor")||0);
console.log(JSON.stringify({event:"secondary_discovery_started",cities:cities.length,families:FAMILIES.length,domains:DIRECTORY_DOMAINS.length,cursor}));

while(true){
  try{
    const scoped=await redis.sCard(campaignLeadSetKey(PROFILE_JOB));
    if(scoped>=TARGET_TOTAL){await sleep(30000);continue;}
    const city=cities[cursor%cities.length],family=FAMILIES[familyCursor%FAMILIES.length],domain=DIRECTORY_DOMAINS[domainCursor%DIRECTORY_DOMAINS.length];
    const queries=[
      `site:${domain} ${family} ${city.city} ${city.state}`,
      `${family} ${city.city} ${city.state} ${domain}`,
      `${family} ${city.city} ${city.state}`
    ];
    let body={results:[],count:0,warnings:[]},query="";
    for(const candidateQuery of queries){
      query=candidateQuery;
      body=await fetchJson(`${YOZH_BASE_URL}/api/v1/search`,{
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({query,engine:"bing",locale:"us",limit:SEARCH_LIMIT,scrape:false,proxy_type:"none",max_retries:2})
      },120000);
      const directoryResults=(body.results||[]).filter(result=>isDirectoryUrl(result?.url)&&hostOf(result.url).includes(domain.replace(/^www\./,"")));
      if(directoryResults.length){
        const scrapedResults=await scrapeDirectoryProfiles(directoryResults);
        body={...body,results:scrapedResults,count:scrapedResults.length};
        break;
      }
      body={...body,results:[],count:0};
    }
    let added=0,rejected={};
    for(const result of body.results||[]){
      const r=await saveCandidate({result,city:city.city,state:city.state,family,domain});
      if(r.accepted)added++;else rejected[r.reason]=(rejected[r.reason]||0)+1;
    }
    await redis.hIncrBy("recover:secondary:stats","searches",1);
    await redis.hIncrBy("recover:secondary:stats","results",Number(body.count||0));
    await redis.hSet("recover:secondary:stats",{last_city:`${city.city}, ${city.state}`,last_family:family,last_domain:domain,last_added:String(added),last_at:new Date().toISOString()});
    console.log(JSON.stringify({event:"secondary_discovery_cycle",city:`${city.city}, ${city.state}`,family,domain,query,results:Number(body.count||0),added,rejected,warnings:body.warnings||[]}));
    domainCursor++; if(domainCursor%DIRECTORY_DOMAINS.length===0)familyCursor++; if(familyCursor%FAMILIES.length===0&&domainCursor%DIRECTORY_DOMAINS.length===0)cursor++;
    await redis.mSet(["recover:secondary:cursor",String(cursor),"recover:secondary:family_cursor",String(familyCursor),"recover:secondary:domain_cursor",String(domainCursor)]);
  }catch(error){
    await redis.hIncrBy("recover:secondary:stats","errors",1);
    console.error("secondary discovery error",error?.message||error);
  }
  await sleep(LOOP_MS);
}
// railway-secondary-discovery-rollout 2026-09-21T04:36Z
