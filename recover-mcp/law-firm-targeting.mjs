function normalize(value=""){return String(value||"").toLowerCase().replace(/[^a-z0-9]+/g," ").trim();}

const LAW_SIGNAL=/\b(law firm|law office|law offices|attorney|attorneys|lawyer|lawyers|legal counsel)\b/;
const NON_FIRM=/\b(bail bonds?|court reporter|process server|notary|paralegal service|legal document preparer|legal aid society|legal services? plan|legal svc plan|legal clinic|law library|lawyers? building|lawyer referral|bar association|courthouse|district attorney|u s attorney|united states attorney|attorney general|city attorney|county attorney|state attorney|prosecuting attorney|prosecutor(?:'s)? office|public defender|chapter 13 trustee|bankruptcy trustee|advocacy program|children'?s advocacy|victim advocate|law school|government office|government agency|police department|sheriff(?:'s)? office|law enforcement|realty|realtors?|real estate brokerage|property management|title company|mortgage broker|insurance agency|tax preparation)\b/;

export const LAW_PRACTICES=[
  {key:"personal_injury",label:"personal injury",target:true,re:/\b(personal injury|injury lawyer|injury attorney|accident lawyer|accident attorney|car accident|truck accident|wrongful death|slip and fall|premises liability|medical malpractice)\b/},
  {key:"settlement_claims",label:"settlement/claims",target:true,re:/\b(settlement lawyer|settlement attorney|insurance claim|insurance dispute|injury settlement|claim denial)\b/},
  {key:"auto_accident",label:"auto accident",target:true,re:/\b(car accident|auto accident|motor vehicle accident|truck accident|motorcycle accident)\b/},
  {key:"medical_malpractice",label:"medical malpractice",target:true,re:/\b(medical malpractice|medical negligence|birth injury|hospital negligence)\b/},
  {key:"dui_traffic",label:"DUI/traffic",target:true,re:/\b(dui|dwi|traffic defense|traffic lawyer|license suspension)\b/},
  {key:"family_divorce",label:"family/divorce",target:true,re:/\b(family law|family lawyer|family attorney|divorce|custody|child custody|child support|spousal support|alimony|dissolution of marriage)\b/},
  {key:"criminal_defense",label:"criminal defense",target:true,re:/\b(criminal defense|criminal lawyer|criminal attorney|dui|dwi|drug crimes?|felony|misdemeanor|expungement|white collar crime|sex crimes?|traffic defense)\b/},
  {key:"estate_probate",label:"estate/probate",target:true,re:/\b(estate planning|probate|wills? and trusts?|trusts? and estates?|elder law|guardianship)\b/},
  {key:"bankruptcy",label:"bankruptcy",target:true,re:/\b(bankruptcy|chapter 7|chapter 11|chapter 13|debt relief)\b/},
  {key:"immigration",label:"immigration",target:true,re:/\b(immigration|visa|green card|citizenship|deportation|asylum)\b/},
  {key:"employment",label:"employment/labor",target:true,re:/\b(employment law|labor law|wrongful termination|workplace discrimination|wage and hour)\b/},
  {key:"business",label:"business/corporate",re:/\b(business law|corporate law|corporate attorney|business attorney|mergers? and acquisitions?|commercial law)\b/},
  {key:"real_estate",label:"real estate",target:true,re:/\b(real estate law|real estate attorney|property law|landlord tenant|land use|zoning)\b/},
  {key:"workers_comp",label:"workers' compensation",target:true,re:/\b(workers'? compensation|workers'? comp|work injury)\b/},
  {key:"disability",label:"disability",target:true,re:/\b(social security disability|ssdi|ssi disability|disability benefits)\b/},
  {key:"tax",label:"tax",re:/\b(tax law|tax attorney|irs|tax controversy|tax litigation)\b/},
  {key:"intellectual_property",label:"intellectual property",re:/\b(intellectual property|patent|trademark|copyright)\b/},
  {key:"civil_litigation",label:"civil litigation",target:true,re:/\b(civil litigation|commercial litigation|general litigation|trial lawyer)\b/}
];

export const TARGET_LAW_PRACTICES=LAW_PRACTICES.filter(x=>x.target);
export const PREFERRED_LAW_PRACTICES=TARGET_LAW_PRACTICES.map(x=>x.label);

export function lawFirmPracticeAreas(value=""){
  const text=normalize(value);
  return LAW_PRACTICES.filter(p=>p.re.test(text)).map(p=>p.label);
}

export function lawFirmPracticeKeys(value=""){
  const text=normalize(value);
  return LAW_PRACTICES.filter(p=>p.re.test(text)).map(p=>p.key);
}

export function matchesLawPractice(value="",focus=""){
  const normalized=normalize(focus).replace(/\s+/g,"_");
  if(!normalized) return lawFirmPracticeKeys(value).length>0;
  const p=LAW_PRACTICES.find(x=>x.key===normalized||normalize(x.label).replace(/\s+/g,"_")===normalized);
  return p ? p.re.test(normalize(value)) : false;
}

const BLOCKED_LAW_EMAIL_DOMAINS=new Set([
  "duckduckgo.com",
  "attorneyyellowpages.com",
  "example.com",
  "example.org",
  "example.net"
]);

export function isUsableLawEmail(value=""){
  const email=String(value||"").trim().toLowerCase();
  if(!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,24}$/.test(email))return false;
  const [local,domain]=email.split("@");
  if(!local||!domain)return false;
  if([...BLOCKED_LAW_EMAIL_DOMAINS].some(d=>domain===d||domain.endsWith("."+d)))return false;
  if(/^(?:www\.|u00(?:3c|3e)|error-lite(?:\+.*)?|jane\.?doe|janedoe|john\.?doe|johndoe|jdoe|doe[_\. -]?[a-z]?|your|test|example|first|firstname\.?lastname|first\.?last|flast|press|admissions|sale-\d+|webcust|faxagent(?:\.help)?|webmaster|postmaster|hostmaster|abuse|noreply|no-reply|donotreply|no-email|noemail)/i.test(local))return false;
  if(/\.(?:png|jpe?g|gif|webp|svg|local)$/i.test(domain))return false;
  if(/(?:com|net|org)(?:please|www|first|last|the|email|contact)/i.test(domain))return false;
  if(/(?:yoursite|yourdomain|placeholder|invalid)\./i.test(domain))return false;
  if(/\.(?:echa|local|invalid)$/i.test(domain))return false;
  const blockedContactDomains=["amazon.com","craigslist.org","linktr.ee","zoo.org","apus.edu","wallace.edu","piercecollege.edu","mcafee.com","axacore.com","cfma.org"];
  if(blockedContactDomains.some(d=>domain===d||domain.endsWith("."+d)))return false;
  return true;
}

export function lawFirmNameShape(value={}){
  const raw=typeof value==="string"?value:String(value?.name||value?.title||"");
  const name=raw.replace(/\s+/g," ").trim();
  if(!name)return "unknown";
  if(/\b(?:attorneys at law|attorneys|lawyers|partners|associates|law group|legal group)\b/i.test(name)||
     /\s(?:&|and)\s/i.test(name))return "multi";
  if(/\b(?:law firm|pllc|p\.c\.|pc|p\.a\.|pa|llp|professional corporation)\b/i.test(name))return "firm";
  if(/^the?\s*law office of\s+[A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){1,4}$/i.test(name)||
     /\battorney(?:\s+at\s+law)?\b/i.test(name)||
     /^[A-Z][A-Za-z.'’-]+(?:\s+[A-Z][A-Za-z.'’-]+){1,3}(?:,?\s+Esq\.?)?$/i.test(name))return "solo";
  return "unknown";
}

export function isPreferredLawFirmSize(value=0){
  const n=Number(value||0);
  return Number.isFinite(n)&&n>=2&&n<=10;
}

export function qualifiesNoWebsiteLawLead(lead={}){
  const website=String(lead.website||"").trim();
  const contacts=Array.isArray(lead.emails)?lead.emails:[lead.email].filter(Boolean);
  const sourceVerified=lead.email_source_verified===true;
  const attorneyCount=Number(lead.attorney_count_estimate||lead.attorney_count||0);
  const sizeEvidenceVerified=lead.attorney_count_evidence_verified===true;
  // Campaign invariant: send-ready means law firm + no owned website +
  // explicitly evidenced 2-10 attorneys + source-backed usable/contactable email.
  return !/^https?:\/\//i.test(website) &&
    sizeEvidenceVerified &&
    isPreferredLawFirmSize(attorneyCount) &&
    sourceVerified &&
    contacts.some(isUsableLawEmail);
}

export function shouldPauseLawDiscovery({pendingEnrichment=0,limit=1000}={}){
  return Number(pendingEnrichment||0)>=Math.max(1,Number(limit||1000));
}

export function lawResearchQueries(lead={}){
  const name=String(lead.name||lead.title||"").replace(/"/g,"").trim();
  const city=String(lead.city||lead.locality||"").trim();
  const region=String(lead.region||lead.state||lead.state_code||"").trim();
  const phone=String(lead.phone||"").replace(/\D+/g,"").slice(-10);
  if(!name)return [];
  const where=[city,region].filter(Boolean).join(" ");
  const queries=[];
  if(phone){
    queries.push(
      `"${phone}" "${name}"`,
      `"${phone}" "${name}" email`
    );
  }
  queries.push(
    `"${name}" ${where} email`.trim(),
    `"${name}" ${where} attorney contact`.trim(),
    `"${name}" "notice to creditors" email`.trim(),
    `"${name}" "Attorney for" email`.trim(),
    `"${name}" "represented by" email`.trim(),
    `"${name}" bankruptcy email`.trim(),
    `"${name}" "legal notice" email`.trim(),
    `"${name}" ${region} state bar email`.trim(),
    `"${name}" ${region} court email`.trim(),
    `"${name}" ${region} attorney email filetype:pdf`.trim(),
    `"${name}" ${where} site:allbiz.com email`.trim(),
    `"${name}" ${where} site:chamberofcommerce.com email`.trim(),
    `"${name}" ${region} site:justia.com`.trim(),
    `"${name}" ${region} site:lawyers.com`.trim()
  );
  return [...new Set(queries)].slice(0,14);
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
  if(!lead.website) add(25,"no owned website — website-build opportunity");
  else add(-10,"already has owned website");
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
