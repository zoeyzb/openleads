function normalizeText(value="") {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function normalizeDomain(value="") {
  try {
    const url = value.includes("://") ? new URL(value) : new URL("https://" + value);
    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return String(value).toLowerCase().replace(/^www\./, "").replace(/\/$/, "");
  }
}
function normalizePhone(value="") {
  return String(value).replace(/\D/g, "").slice(-10);
}
function normalizeEmails(value) {
  const values=Array.isArray(value)?value:String(value||"").split(/[;,\s]+/);
  return [...new Set(values.map(x=>String(x).trim().toLowerCase()).filter(x=>/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))];
}

export function mergeLeadRecords(existing={}, incoming={}) {
  const merged={...existing,...incoming};
  merged.emails=[...new Set([
    ...normalizeEmails(existing.emails||existing.email||""),
    ...normalizeEmails(incoming.emails||incoming.email||"")
  ])];
  for (const field of ["phone","website","social_profile_url","owner_name","google_maps_url","place_id","cid","data_id","category","address","city","region"]) {
    if ((incoming[field]===undefined || incoming[field]===null || String(incoming[field]).trim()==="") && existing[field]) {
      merged[field]=existing[field];
    }
  }
  if ((!Array.isArray(incoming.tech_stack) || incoming.tech_stack.length===0) && Array.isArray(existing.tech_stack) && existing.tech_stack.length) {
    merged.tech_stack=existing.tech_stack;
  }
  for (const field of ["cms_detected","ssl_valid","site_speed_ms","website_status"]) {
    if ((incoming[field]===undefined || incoming[field]===null || incoming[field]==="") && existing[field]!==undefined && existing[field]!==null && existing[field]!=="") {
      merged[field]=existing[field];
    }
  }
  return merged;
}

const US_STATES = {
  alabama:"al", alaska:"ak", arizona:"az", arkansas:"ar", california:"ca", colorado:"co",
  connecticut:"ct", delaware:"de", florida:"fl", georgia:"ga", hawaii:"hi", idaho:"id",
  illinois:"il", indiana:"in", iowa:"ia", kansas:"ks", kentucky:"ky", louisiana:"la",
  maine:"me", maryland:"md", massachusetts:"ma", michigan:"mi", minnesota:"mn",
  mississippi:"ms", missouri:"mo", montana:"mt", nebraska:"ne", nevada:"nv",
  "new hampshire":"nh", "new jersey":"nj", "new mexico":"nm", "new york":"ny",
  "north carolina":"nc", "north dakota":"nd", ohio:"oh", oklahoma:"ok", oregon:"or",
  pennsylvania:"pa", "rhode island":"ri", "south carolina":"sc", "south dakota":"sd",
  tennessee:"tn", texas:"tx", utah:"ut", vermont:"vt", virginia:"va", washington:"wa",
  "west virginia":"wv", wisconsin:"wi", wyoming:"wy", "district of columbia":"dc"
};
const STATE_CODES = new Set(Object.values(US_STATES));

function stateCode(value="") {
  const text = normalizeText(value);
  if (!text) return "";
  if (US_STATES[text]) return US_STATES[text];
  if (STATE_CODES.has(text)) return text;
  for (const [name, code] of Object.entries(US_STATES)) {
    if (text.includes(name)) return code;
  }
  const tokens = text.split(" ");
  return tokens.find(token => STATE_CODES.has(token)) || "";
}

export function matchesRequestedLocation(lead, requestedLocation) {
  const requested = normalizeText(requestedLocation);
  if (!requested) return true;

  const leadCity = normalizeText(lead.city || lead.locality || lead.town || "");
  const leadRegionRaw = lead.region || lead.state || lead.state_code || lead.province || "";
  const leadRegion = normalizeText(leadRegionRaw);
  const leadAddress = normalizeText(lead.address || lead.full_address || lead.formatted_address || "");
  const hay = normalizeText([leadCity, leadRegion, leadAddress].filter(Boolean).join(" "));
  if (!hay) return false;

  const requestedState = stateCode(requested);
  const leadState = stateCode(leadRegion || leadAddress);
  if (requestedState && leadState && requestedState !== leadState) return false;

  const requestedWithoutState = requested
    .replace(new RegExp("\\b(" + Object.keys(US_STATES).map(x => x.replace(/ /g, "\\s+")).join("|") + ")\\b", "g"), " ")
    .replace(new RegExp("\\b(" + [...STATE_CODES].join("|") + ")\\b", "g"), " ")
    .replace(/\s+/g, " ")
    .trim();

  const requestedTokens = requestedWithoutState.split(" ").filter(token => token.length >= 3);
  if (requestedTokens.length) {
    return requestedTokens.every(token => hay.includes(token));
  }
  if (requestedState) return leadState === requestedState || hay.includes(requested);
  return hay.includes(requested);
}

function identityKeys(lead) {
  const keys = [];
  if (lead.place_id) keys.push("place:" + String(lead.place_id));
  if (lead.cid) keys.push("cid:" + String(lead.cid));
  const domain = normalizeDomain(lead.website || lead.domain || "");
  if (domain) keys.push("domain:" + domain);
  const phone = normalizePhone(lead.phone || "");
  if (phone) keys.push("phone:" + phone);
  const nameAddress = normalizeText((lead.name || lead.title || "") + "|" + (lead.address || ""));
  if (nameAddress) keys.push("na:" + nameAddress);
  return keys;
}

export function upsertQualifiedLeads(existing, incoming) {
  const rows = [];
  const keyToIndex = new Map();

  const upsert = (lead) => {
    const keys = identityKeys(lead);
    let index = -1;
    for (const key of keys) {
      if (keyToIndex.has(key)) {
        index = keyToIndex.get(key);
        break;
      }
    }
    if (index === -1) {
      index = rows.length;
      rows.push(lead);
    } else {
      rows[index] = mergeLeadRecords(rows[index], lead);
    }
    for (const key of identityKeys(rows[index])) keyToIndex.set(key, index);
  };

  for (const lead of existing || []) upsert(lead);
  for (const lead of incoming || []) upsert(lead);
  return rows;
}
