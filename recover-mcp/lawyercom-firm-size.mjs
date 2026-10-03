function stripHtml(input=""){
  return String(input||"")
    .replace(/<script[\s\S]*?<\/script>/gi," ")
    .replace(/<style[\s\S]*?<\/style>/gi," ")
    .replace(/<[^>]+>/g," ")
    .replace(/&nbsp;|&#160;/gi," ")
    .replace(/&amp;/gi,"&")
    .replace(/&quot;/gi,'"')
    .replace(/&#39;|&apos;/gi,"'")
    .replace(/\s+/g," ")
    .trim();
}

const RELATED_SECTION_RE=/^(?:(?:top\s+local|nearby)\s+(?:lawyers?|attorneys?|law\s+firms?)|(?:lawyers?|attorneys?|law\s+firms?)\s+nearby|similar\s+(?:lawyers?|attorneys?|law\s+firms?)|related\s+(?:lawyers?|attorneys?|law\s+firms?)|recommended\s+(?:lawyers?|attorneys?|law\s+firms?)|reviews?)$/i;

export function targetScopedLawyerComHtml(html=""){
  const raw=String(html||"");
  if(!raw)return "";
  let cut=raw.length;
  for(const m of raw.matchAll(/<h([2-5])\b[^>]*>([\s\S]{0,500}?)<\/h\1>/gi)){
    const label=stripHtml(m[2]);
    if(RELATED_SECTION_RE.test(label)){
      cut=Math.min(cut,m.index);
      break;
    }
  }
  return raw.slice(0,cut);
}

export function targetScopedLawyerComFirmSize(html=""){
  const scoped=targetScopedLawyerComHtml(html);
  const plain=stripHtml(scoped);
  if(!plain)return 0;

  const range=plain.match(/\b(?:firm|office)\s+size\s*:?\s*(\d{1,2})\s*(?:to|[-–])\s*(\d{1,2})\b/i);
  if(range){
    const lo=Number(range[1]),hi=Number(range[2]);
    if(lo>0&&hi>=lo&&hi<=100)return lo>=2?hi:1;
  }

  const exact=plain.match(/\b(?:firm|office)\s+size\s*:?\s*(\d{1,3})\b/i);
  if(exact){
    const n=Number(exact[1]);
    if(n>0&&n<=500)return n;
  }

  const officeLocation=plain.match(/\bat\s+this\s+office\s+location\s*,?\s+there\s+(?:are|is)\s+(\d{1,3})\s+(?:lawyers?|attorneys?)\b/i);
  if(officeLocation){
    const n=Number(officeLocation[1]);
    if(n>0&&n<=500)return n;
  }

  const officeWith=plain.match(/\b(?:law\s+office|law\s+firm|office|firm)\s+with\s+(\d{1,3})\s+(?:lawyers?|attorneys?)\b/i);
  if(officeWith){
    const n=Number(officeWith[1]);
    if(n>0&&n<=500)return n;
  }

  if(/\b(?:firm|office)\s+size\s*:?\s*(?:solo|sole\s+practi(?:tioner|oner))\b/i.test(plain))return 1;
  return 0;
}


/**
 * Lawyer.com final headcount policy.
 *
 * Lawyer.com "Lawyers" sections can contain unrelated or stale profile cards.
 * Only explicit target-firm size language is accepted as final headcount
 * evidence. Roster/profile links may still be used as research hints for email
 * discovery, but they must not manufacture a numeric firm size.
 */
export function trustedLawyerComHeadcount(html=""){
  return targetScopedLawyerComFirmSize(html);
}
