export const PLATFORM_DOMAINS = [
  'yellowpages.com','chamberofcommerce.com','manta.com','bbb.org','yelp.com','angi.com','homeadvisor.com',
  'thumbtack.com','houzz.com','nextdoor.com','superpages.com','porch.com','buildzoom.com','facebook.com','mapquest.com',
  'birdeye.com','loc8nearme.com','merchantcircle.com','cylex.us.com','yellowbook.com','hotfrog.com','dexknows.com',
  'ezlocal.com','citysquares.com','2findlocal.com','opendi.us','find-open.com','whitepages.com','spokeo.com','anywho.com',
  'callercenter.com','reportedcalls.com','areacodes.net','usareacodes.net','thisnumber.com','411.com'
];
const FREE_MAIL = new Set(['gmail.com','yahoo.com','outlook.com','hotmail.com','icloud.com','aol.com','proton.me','protonmail.com']);
export function normalizeText(v=''){return String(v||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();}
export function normalizePhone(v=''){return String(v||'').replace(/\D/g,'').slice(-10);}
export function emailsFrom(text=''){return [...new Set((String(text).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig)||[]).map(x=>x.toLowerCase()))];}
export function hostOf(url=''){try{return new URL(url).hostname.toLowerCase().replace(/^www\./,'');}catch{return '';}}
export function platformDomain(host=''){const h=String(host||'').toLowerCase().replace(/^www\./,'');return PLATFORM_DOMAINS.some(d=>h===d||h.endsWith('.'+d));}
export function businessTokenScore(text='', business=''){
  const hay=normalizeText(text); const tokens=normalizeText(business).split(' ').filter(t=>t.length>=3 && !['llc','inc','company','corp','services','service'].includes(t));
  if(!tokens.length) return 0; const hits=tokens.filter(t=>hay.includes(t)).length; return hits/tokens.length;
}
export function candidateEmailsFromEvidence({text='',sourceUrl='',business='',phone='',location=''}){
  const p=normalizePhone(phone); const phones=(String(text).match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/g)||[]).map(normalizePhone);
  const exactPhone=Boolean(p && phones.includes(p));
  const nameScore=businessTokenScore(text,business);
  const loc=normalizeText(location); const locationMatch=Boolean(loc && normalizeText(text).includes(loc.split(' ').filter(Boolean)[0]||loc));
  if(!exactPhone && !(nameScore>=0.75 && locationMatch)) return [];
  const sourceHost=hostOf(sourceUrl);
  return emailsFrom(text).filter(email=>{
    const domain=email.split('@')[1]||'';
    if(platformDomain(domain)) return false;
    if(platformDomain(sourceHost) && domain===sourceHost) return false;
    if(!platformDomain(sourceHost) && domain===sourceHost && !FREE_MAIL.has(domain)) return false;
    return true;
  });
}
export function compactLocation(location=''){
  const raw=String(location||'').trim();
  const m=raw.match(/(?:^|,\s*)([^,]+),\s*([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*$/i);
  if(m) return `${m[1].trim()} ${m[2].toUpperCase()}`;
  return raw.replace(/\b\d{5}(?:-\d{4})?\b/g,'').replace(/\s+/g,' ').replace(/^\s*\d+[A-Za-z-]*\s+[^,]+,\s*/,'').trim();
}
export function searchQueries({business='',phone='',location=''}){
  const b=String(business||'').trim(), p=normalizePhone(phone), l=compactLocation(location);
  const q=[
    `site:facebook.com \"${b}\" ${l}`,
    `site:yelp.com \"${b}\" ${l}`,
    `site:chamberofcommerce.com \"${b}\" ${l}`,
    `site:manta.com \"${b}\" ${l}`,
    `site:bbb.org \"${b}\" ${l}`,
    `\"${b}\" ${l} email`,
    `\"${b}\" ${l} contact`,
    `\"${b}\" ${l}`,
    p?`\"${b}\" \"${p}\"`:''
  ];
  return [...new Set(q.filter(Boolean))];
}
