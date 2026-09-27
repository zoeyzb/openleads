function normalize(value=""){return String(value||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();}

const LAW_SIGNAL=/\b(law firm|law office|law offices|attorney|attorneys|lawyer|lawyers|legal counsel)\b/;
const NON_FIRM=/\b(bail bonds?|court reporter|process server|notary|paralegal service|legal document preparer|legal aid society|bar association|courthouse|district attorney|public defender|government office)\b/;
const CRIMINAL=/\b(criminal|criminal defense|dui|dwi|traffic defense|sex crimes?|white collar crime|drug crimes?|felony|misdemeanor|expungement|bail)\b/;

export const PREFERRED_LAW_PRACTICES=[
  "personal injury","family law","estate planning","probate","employment law",
  "business law","corporate law","real estate law","civil litigation",
  "workers compensation","medical malpractice","elder law","tax law"
];

export function lawFirmPracticeAreas(value=""){
  const text=normalize(value);
  return PREFERRED_LAW_PRACTICES.filter(p=>text.includes(p));
}

export function isCriminalLawFirm(lead={}){
  const text=normalize([lead.category,lead.industry,lead.name,lead.title,lead.description,lead.descriptions].filter(Boolean).join(" "));
  return CRIMINAL.test(text);
}

export function isLawFirmLead(lead={}){
  const category=normalize(lead.category||lead.industry||"");
  const text=normalize([category,lead.name,lead.title,lead.description,lead.descriptions].filter(Boolean).join(" "));
  if(!LAW_SIGNAL.test(text)) return false;
  if(NON_FIRM.test(text)) return false;
  if(CRIMINAL.test(text)) return false;
  return true;
}

export function scoreLawFirmLead(lead={}){
  let score=0; const reasons=[]; const add=(points,reason)=>{score+=points;reasons.push({points,reason});};
  const text=normalize([lead.category,lead.name,lead.title,lead.description,lead.descriptions].filter(Boolean).join(" "));
  if(isLawFirmLead(lead)) add(30,"non-criminal law firm");
  const practices=lawFirmPracticeAreas(text);
  if(practices.length) add(15,"preferred practice area");
  if(lead.phone) add(10,"phone available");
  if(lead.website) add(10,"owned website available for enrichment");
  const emails=Array.isArray(lead.emails)?lead.emails:[lead.email].filter(Boolean);
  if(emails.length) add(20,"email already available");
  const reviews=Number(lead.review_count||lead.reviews||0);
  if(reviews>=10) add(5,"established review footprint");
  if(reviews>=50) add(5,"strong review footprint");
  if(Number(lead.review_rating||lead.rating||0)>=4.2) add(5,"strong rating");
  score=Math.min(100,score);
  const tier=score>=75?"strong":score>=55?"qualified":score>=35?"enrich":"reject";
  return {score,tier,reasons,practice_areas:practices};
}
