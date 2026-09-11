function normalize(value=""){
  return String(value||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
}

// Strict campaign targeting shared by workers and live exports.
const REJECT_CATEGORY=/\b(pest control|exterminator|extermination|auto air conditioning|car air conditioning|auto repair|automotive|auto parts|automobile parts|car parts|car dealer|vehicle repair|auto body|body shop|tire shop|tire service|oil change|motor repair|motor service|motors|septic|septic tank|septic service|appliance|appliance repair|appliance parts|appliance store|parts supplier|equipment supplier|supplier|supply|distributor|distributors|wholesale|wholesaler|manufacturer|hardware store|retail|general contractor|construction company|construction service|roofing|roofer|landscaping|landscape contractor|remodeling|property management|home warranty|warranty|restaurant|cafe|food|hotel|motel|lawyer|attorney|dentist|doctor|medical|insurance|real estate|beauty|salon|school|church|marketing|software|computer repair)\b/;

const STRONG_CATEGORY=/\b(hvac contractor|heating contractor|air conditioning contractor|air conditioning repair service|ac repair service|cooling contractor|plumber|plumbing contractor|plumbing service|furnace repair service|furnace contractor|boiler repair service|boiler contractor|air duct cleaning service|duct cleaning service|air duct contractor|ventilation contractor|refrigeration contractor|refrigeration service)\b/;

const SERVICE_SIGNAL=/\b(hvac|heating|cooling|air conditioning|ac repair|furnace|boiler|air duct|duct cleaning|ventilation|plumb|refrigeration)\b/;
const REJECT_ANYWHERE=/\b(pest control|exterminator|extermination|septic|septic tank|septic service|motor repair|motor service|motors|appliance|wholesale|wholesaler|supplier|supply|distributor|distributors|manufacturer|hardware|retail|general contractor|construction|roofing|roofer|landscaping|landscape contractor|remodeling|property management|home warranty|warranty|hvac filters?|filter supply|auto air conditioning|car air conditioning|auto repair|automotive|auto parts|automobile parts|car parts|car dealer|vehicle repair|auto body|body shop|tire shop|tire service|oil change)\b/;

export function isCoreHomeServiceLead(lead={}){
  const category=normalize(lead.category||lead.industry||"");
  const name=normalize(lead.name||lead.title||"");
  const desc=normalize(lead.description||lead.descriptions||"");
  const categoryAndName=[category,name].filter(Boolean).join(" ");
  const evidence=[name,desc].filter(Boolean).join(" ");

  if(REJECT_CATEGORY.test(category)) return false;
  if(REJECT_ANYWHERE.test([category,name,desc].join(" "))) return false;
  if(/\b(supplier|supply|distributor|distributors|wholesale|manufacturer|parts|retail store|equipment store|warranty|septic|motors|construction|roofing|landscaping|remodeling)\b/.test(category)) return false;
  if(STRONG_CATEGORY.test(category)) return true;

  if(/\b(mechanical contractor|mechanical service|contractor|home service)\b/.test(category)){
    return SERVICE_SIGNAL.test(evidence);
  }

  if(!category || /\b(service establishment|business to business service)\b/.test(category)){
    return SERVICE_SIGNAL.test(categoryAndName);
  }

  return false;
}

export function isCoreHomeServiceIndustry(value=""){
  return /\b(hvac|heating|cooling|air conditioning|home comfort|plumb|furnace|boiler|duct|ventilation|refrigeration)\b/.test(normalize(value));
}
