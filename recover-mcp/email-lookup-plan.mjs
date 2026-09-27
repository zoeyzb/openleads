import { normalizePhone, compactLocation, searchBusinessName } from './email-enrichment-evidence.mjs';

function phoneSearch(phone=''){
  const p=normalizePhone(phone);
  return p.length===10 ? `"${p}"` : '';
}

export function buildLookupPlan({business='',phone='',location='',address='',noWebsite=false}={}){
  const raw=String(business||'').trim();
  const b=searchBusinessName(raw);
  const p=normalizePhone(phone);
  const l=compactLocation(location);
  const a=compactLocation(address);
  if(noWebsite){
    const ps=phoneSearch(p);
    return {
      stage1:[
        ps?`site:facebook.com ${ps} "${b}"`:'',
        ps?`site:chamberofcommerce.com ${ps} "${b}"`:'',
        ps?`site:manta.com ${ps} "${b}"`:'',
        ps?`site:bbb.org ${ps} "${b}"`:'',
        ps?`site:yelp.com ${ps} "${b}"`:''
      ].filter(Boolean),
      stage2:[
        ps?`${ps} "${b}"`:'',
        ps?`${ps} email`:'',
        a?`"${b}" "${a}"`:'',
        `"${b}" ${l} contact`,
        ps?`site:angi.com ${ps} "${b}"`:'',
        ps?`site:homeadvisor.com ${ps} "${b}"`:'',
        ps?`site:thumbtack.com ${ps} "${b}"`:''
      ].filter(Boolean)
    };
  }
  return {
    stage1:[
      p?`"${p}" "${b}"`:'',
      `"${b}" ${l} email`,
      `"${b}" ${l} contact`
    ].filter(Boolean),
    stage2:[
      a?`"${b}" "${a}"`:'',
      `site:facebook.com "${b}" ${l}`,
      `site:yelp.com "${b}" ${l}`,
      `site:bbb.org "${b}" ${l}`
    ].filter(Boolean)
  };
}