const TRUSTED_INDEX_HOSTS=["lawyer.com","martindale.com","lawyers.com"];

function normalize(value=""){
  return String(value||"").toLowerCase().replace(/&/g," and ").replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim();
}
function hostOf(value=""){
  try{return new URL(String(value||"")).hostname.toLowerCase().replace(/^www\./,"");}
  catch{return "";}
}
function phone10(value=""){return String(value||"").replace(/\D/g,"").slice(-10);}
function significantFirmTokens(value=""){
  const stop=new Set(["the","law","legal","firm","firms","office","offices","attorney","attorneys","lawyer","lawyers","group","llc","pllc","pc","pa","llp","apc","professional","corporation","associates","association","at","of","and"]);
  return normalize(value).split(" ").filter(x=>x.length>=3&&!stop.has(x));
}
function sourceShape(url=""){
  let u;
  try{u=new URL(String(url||""));}catch{return {firmSpecific:false,lawyersListing:false};}
  const host=u.hostname.toLowerCase().replace(/^www\./,""), path=u.pathname.toLowerCase();
  const firmSpecific=
    (host==="lawyer.com"||host.endsWith(".lawyer.com")) ? /^\/firms?\/[a-z0-9]/.test(path) :
    (host==="martindale.com"||host.endsWith(".martindale.com")) ? /^\/organization\/[a-z0-9]/.test(path) :
    (host==="lawyers.com"||host.endsWith(".lawyers.com")) ? /\/(?:law-firm|firm|attorney-profile)\//.test(path) :
    false;
  const lawyersListing=(host==="lawyers.com"||host.endsWith(".lawyers.com")) &&
    /\/law-firms\/?(?:$|[?#])/.test(path+u.search+u.hash);
  return {firmSpecific,lawyersListing};
}
function targetCount(text=""){
  const plain=String(text||"");
  const patterns=[
    /\bfirm\s+size\s*:?\s*(\d{1,2})\b/i,
    /\blaw\s+(?:firm|office)\s+with\s+(\d{1,2})\s+lawyers?\b/i,
    /\b(?:attorneys|lawyers)\s*[:#-]\s*(\d{1,2})\b/i
  ];
  for(const re of patterns){
    const n=Number(plain.match(re)?.[1]||0);
    if(n>=2&&n<=10)return n;
  }
  return 0;
}
function identityStrength(record={},lead={}){
  const text=String(record.text||"");
  const norm=normalize(text);
  const full=normalize(lead.name||lead.title||"");
  const tokens=significantFirmTokens(lead.name||lead.title||"");
  const tokenHits=tokens.filter(t=>norm.includes(t)).length;
  const nameStrong=Boolean((full.length>=8&&norm.includes(full))||(tokens.length>=2&&tokenHits>=Math.min(3,tokens.length)));
  if(!nameStrong)return {strong:false,phone:false,geo:false};

  const phone=phone10(lead.phone);
  const phoneMatch=Boolean(phone&&phone10(text).includes(phone));
  const city=normalize(lead.city||lead.locality||"");
  const state=normalize(lead.region||lead.state||lead.state_code||"");
  const geo=Boolean((city&&norm.includes(city))&&(state&&new RegExp("(?:^| )"+state.replace(/[^a-z0-9]/g,"")+"(?: |$)").test(norm)));
  return {strong:nameStrong&&(phoneMatch||geo),phone:phoneMatch,geo};
}

/**
 * Conservative positive-only indexed headcount evidence.
 *
 * Never uses snippets to mark solo/oversize. A 2-10 count is accepted when:
 *  - exact firm identity + exact phone appear on one firm-specific trusted result, or
 *  - two distinct trusted directory hosts independently publish the same 2-10
 *    count for a strong name+city+state identity.
 */
export function trustedIndexedTargetHeadcount(records=[],lead={}){
  const matches=[];
  for(const record of records||[]){
    const source=String(record?.url||"");
    const host=hostOf(source);
    if(!TRUSTED_INDEX_HOSTS.some(h=>host===h||host.endsWith("."+h)))continue;
    const shape=sourceShape(source);
    if(!shape.firmSpecific&&!shape.lawyersListing)continue;
    const count=targetCount(record?.text||"");
    if(count<2||count>10)continue;
    const identity=identityStrength(record,lead);
    if(!identity.strong)continue;
    // Lawyers.com city/practice listing pages can publish the exact firm card,
    // phone, and "Law Office with N lawyers" even when Railway cannot fetch the
    // page directly. Accept those listing snippets only with exact phone; they
    // never participate in weaker name+geo cross-source agreement.
    if(shape.lawyersListing&&!identity.phone)continue;
    matches.push({
      count,source,host,phone:identity.phone,
      listing:shape.lawyersListing,
      firmSpecific:shape.firmSpecific,
      text:String(record.text||"").slice(0,1200)
    });
  }
  if(!matches.length)return null;

  const phoneExact=matches.find(x=>x.phone);
  if(phoneExact){
    return {
      count:phoneExact.count,
      source:phoneExact.source,
      sources:[phoneExact.source],
      method:phoneExact.listing?"indexed_listing_exact_phone_target_range":"indexed_exact_phone",
      matches:[phoneExact]
    };
  }

  // Cross-source agreement is reserved for dedicated firm/profile URLs.
  // Broad listing pages are never allowed to bootstrap one another by name+geo.
  const crossSourceMatches=matches.filter(x=>x.firmSpecific&&!x.listing);
  const byCount=new Map();
  for(const m of crossSourceMatches){
    if(!byCount.has(m.count))byCount.set(m.count,[]);
    byCount.get(m.count).push(m);
  }
  const eligible=[...byCount.entries()]
    .map(([count,items])=>({count,items,hosts:new Set(items.map(x=>x.host))}))
    .filter(x=>x.hosts.size>=2);
  if(eligible.length!==1)return null;
  const chosen=eligible[0];
  const conflicting=matches.some(x=>x.count!==chosen.count);
  if(conflicting)return null;
  const sources=[...new Set(chosen.items.map(x=>x.source))];
  return {count:chosen.count,source:sources[0],sources,method:"indexed_cross_source_agreement",matches:chosen.items};
}
