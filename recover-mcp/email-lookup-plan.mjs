import { normalizePhone, compactLocation, searchBusinessName } from './email-enrichment-evidence.mjs';

export function buildLookupPlan({business='',phone='',location='',address='',noWebsite=false}={}){
  const raw=String(business||'').trim();
  const b=searchBusinessName(raw);
  const p=normalizePhone(phone);
  const l=compactLocation(location);
  const a=compactLocation(address);
  if(noWebsite){
    return {
      stage1:[
        p?`"${p}" "${b}"`:'',
        p?`site:facebook.com "${p}" "${b}"`:'',
        p?`site:yelp.com "${p}" "${b}"`:''
      ].filter(Boolean),
      stage2:[
        p?`site:bbb.org "${p}" "${b}"`:'',
        p?`site:chamberofcommerce.com "${p}" "${b}"`:'',
        p?`site:manta.com "${p}" "${b}"`:'',
        p?`site:angi.com "${p}" "${b}"`:'',
        p?`site:homeadvisor.com "${p}" "${b}"`:'',
        p?`site:thumbtack.com "${p}" "${b}"`:'',
        a?`"${b}" "${a}" email`:'',
        `"${b}" ${l} email`
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