function normalize(value=""){return String(value||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();}

const LAW_SIGNAL=/\b(law firm|law office|law offices|attorney|attorneys|lawyer|lawyers|legal counsel)\b/;
const NON_FIRM=/\b(bail bonds?|court reporter|process server|notary|paralegal service|legal document preparer|legal aid society|bar association|courthouse|district attorney|public defender|government office)\b/;

export const TARGET_LAW_PRACTICES=[
  {key:"personal_injury",label:"personal injury",re:/\b(personal injury|injury lawyer|injury attorney|accident lawyer|accident attorney|car accident|truck accident|wrongful death|slip and fall|premises liability)\b/},
  {key:"family_divorce",label:"family/divorce",re:/\b(family law|family lawyer|family attorney|divorce|custody|child custody|child support|spousal support|alimony|dissolution of marriage)\b/},
  {key:"criminal_defense",label:"criminal defense",re:/\b(criminal defense|criminal lawyer|criminal attorney|dui|dwi|drug crimes?|felony|misdemeanor|expungement|white collar crime|sex crimes?|traffic defense)\b/}
];

export const PREFERRED_LAW_PRACTICES=TARGET_LAW_PRACTICES.map(x=>x.label);

export function lawFirmPracticeAreas(value=""){
  const text=normalize(value);
  return TARGET_LAW_PRACTICES.filter(p=>p.re.test(text)).map(p=>p.label);
}

export function lawFirmPracticeKeys(value=""){
  const text=normalize(value);
  return TARGET_LAW_PRACTICES.filter(p=>p.re.test(text)).map(p=>p.key);
}

export function matchesLawPractice(value="",focus=""){
  const normalized=normalize(focus).replace(/\s+/g,"_");
  if(!normalized) return lawFirmPracticeKeys(value).length>0;
  const p=TARGET_LAW_PRACTICES.find(x=>x.key===normalized||normalize(x.label).replace(/\s+/g,"_")===normalized);
  return p ? p.re.test(normalize(value)) : false;
}

export function isLawFirmLead(lead={}){
  const category=normalize(lead.category||lead.industry||"");
  const text=normalize([category,lead.name,lead.title,lead.description,lead.descriptions].filter(Boolean).join(" "));
  if(!LAW_SIGNAL.test(text)) return false;
  if(NON_FIRM.test(text)) return false;
  return true;
}

export function scoreLawFirmLead(lead={},options={}){
  let score=0; const reasons=[]; const add=(points,reason)=>{score+=points;reasons.push({points,reason});};
  const text=normalize([lead.category,lead.name,lead.title,lead.description,lead.descriptions].filter(Boolean).join(" "));
  if(isLawFirmLead(lead)) add(25,"law firm");
  const practices=lawFirmPracticeAreas(text);
  if(practices.length) add(25,"target practice");
  if(options.practice_focus&&matchesLawPractice(text,options.practice_focus)) add(10,"requested practice match");
  if(lead.website) add(15,"owned website available for audit");
  if(lead.phone) add(5,"phone available");
  const emails=Array.isArray(lead.emails)?lead.emails:[lead.email].filter(Boolean);
  if(emails.length) add(15,"email already available");
  const reviews=Number(lead.review_count||lead.reviews||0);
  if(reviews>=10) add(5,"established review footprint");
  if(reviews>=50) add(5,"strong review footprint");
  if(Number(lead.review_rating||lead.rating||0)>=4.2) add(5,"strong rating");
  score=Math.min(100,score);
  const tier=score>=75?"strong":score>=55?"qualified":score>=35?"enrich":"reject";
  return {score,tier,reasons,practice_areas:practices};
}
