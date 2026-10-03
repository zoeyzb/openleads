const OUTSCRAPER_BASE_URL = "https://api.outscraper.cloud";

function pick(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") return value;
  }
  return "";
}

export function parseCsv(text="") {
  const rows=[]; let row=[], field="", quoted=false;
  for (let i=0;i<text.length;i++) {
    const ch=text[i];
    if (quoted) {
      if (ch === '"' && text[i+1] === '"') { field+='"'; i++; }
      else if (ch === '"') quoted=false;
      else field+=ch;
    } else {
      if (ch === '"') quoted=true;
      else if (ch === ',') { row.push(field); field=""; }
      else if (ch === '\n') { row.push(field); rows.push(row); row=[]; field=""; }
      else if (ch !== '\r') field+=ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers=rows.shift().map(h=>h.trim());
  return rows.filter(r=>r.some(v=>String(v).trim())).map(r=>{
    const obj={}; headers.forEach((h,i)=>obj[h]=r[i]??""); return obj;
  });
}

export function normalizeExternalLead(row={}, source="external") {
  const website=String(pick(row,["website","Website","site","domain"])||"").trim();
  const phone=String(pick(row,["phone","Phone","phone_number","Phone Number"])||"").trim();
  const address=String(pick(row,["address","Address","full_address","Full Address"])||"").trim();
  const city=String(pick(row,["city","City","borough"])||"").trim();
  const region=String(pick(row,["region","Region","state","State","state_code"])||"").trim();
  const placeId=String(pick(row,["place_id","Place ID","google_place_id"])||"").trim();
  const mapsUrl=String(pick(row,["google_maps_url","Google Maps URL","location_link","maps_url"])||"").trim();
  const category=String(pick(row,["category","Category","type","Type"])||"").trim();
  const rating=Number(pick(row,["rating","Rating","review_rating"])||0) || 0;
  const reviewCount=Number(pick(row,["review_count","Review Count","reviews"])||0) || 0;
  return {
    name:String(pick(row,["name","Name","business_name","Business Name"])||"").trim(),
    category,
    address,
    city,
    region,
    postal_code:String(pick(row,["postal_code","Postal Code","zip","Zip"])||"").trim(),
    phone,
    website,
    place_id:placeId,
    cid:String(pick(row,["cid","CID","google_id"])||"").trim(),
    google_maps_url:mapsUrl,
    review_rating:rating,
    review_count:reviewCount,
    source,
    source_recorded_at:new Date().toISOString()
  };
}

export function normalizeSmartScraperCsv(csvText="") {
  return parseCsv(csvText).map(row=>normalizeExternalLead(row,"smartscraper")).filter(row=>row.name);
}

export function normalizeOutscraperPayload(payload) {
  const data = Array.isArray(payload?.data) ? payload.data
    : Array.isArray(payload) ? payload
    : Array.isArray(payload?.results) ? payload.results
    : [];
  return data.flat(Infinity).filter(x=>x && typeof x==="object")
    .map(row=>normalizeExternalLead(row,"outscraper")).filter(row=>row.name);
}

export async function fetchOutscraperMaps({query, apiKey=process.env.OUTSCRAPER_API_KEY, limit=500, language="en", region="us"}={}) {
  if (!query) throw new Error("Outscraper query is required");
  if (!apiKey) throw new Error("OUTSCRAPER_API_KEY is required");
  const url=new URL("/maps/search",OUTSCRAPER_BASE_URL);
  url.searchParams.set("query",query);
  url.searchParams.set("limit",String(Math.max(1,Math.min(5000,Number(limit)||500))));
  url.searchParams.set("async","false");
  if (language) url.searchParams.set("language",language);
  if (region) url.searchParams.set("region",region);
  const response=await fetch(url,{headers:{"X-API-KEY":apiKey,"accept":"application/json"}});
  const text=await response.text();
  let body; try { body=text?JSON.parse(text):{}; } catch { body={raw:text}; }
  if (!response.ok) throw new Error(`Outscraper ${response.status}: ${JSON.stringify(body).slice(0,500)}`);
  return normalizeOutscraperPayload(body);
}
