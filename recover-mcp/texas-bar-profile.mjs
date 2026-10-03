export function isTexasBarProfileUrl(value=""){
  let u;
  try{u=new URL(String(value||""));}catch{return false;}
  const host=u.hostname.toLowerCase().replace(/^www\./,"");
  if(host!=="texasbar.com"&&!host.endsWith(".texasbar.com"))return false;
  const path=u.pathname;
  const q=u.search;
  return /\/attorneys\/member\.cfm$/i.test(path)&&/\bid=\d+/i.test(q) ||
    /Template\.cfm$/i.test(path)&&/\bContactID=\d+/i.test(q);
}
