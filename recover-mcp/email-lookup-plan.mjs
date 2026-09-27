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
        ps?`${ps} "${b}"`:'',
        ps?`${ps} email`:'',
        a?`"${b}" "${a}"`:'',
        `"${b}" ${l} contact`
      ].filter(Boolean),
      stage2:[
        ps?`site:facebook.com ${ps}`:'',
        ps?`site:yelp.com ${ps}`:'',
        ps?`site:bbb.org ${ps}`:'',
        ps?`site:chamberofcommerce.com ${ps}`:'',
        ps?`site:manta.com ${ps}`:'',
        ps?`site:angi.com ${ps}`:'',
        ps?`site:homeadvisor.com ${ps}`:'',
        ps?`site:thumbtack.com ${ps}`:''
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