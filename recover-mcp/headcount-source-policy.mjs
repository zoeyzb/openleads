export function isFirmSpecificDirectoryHeadcountUrl(source=""){
  try{
    const u=new URL(String(source||""));
    if(!/^https?:$/.test(u.protocol))return false;
    const host=u.hostname.toLowerCase().replace(/^www\./,"");
    const path=u.pathname.toLowerCase();

    // Justia's plural /lawyers/<state>/<city> routes are broad location
    // directories. They list unrelated attorneys and cannot prove the size of
    // one firm. Only an identity-specific /lawyer/<person>-<id> profile may
    // support stored headcount evidence.
    if(host==="justia.com"||host.endsWith(".justia.com")){
      return /^\/lawyer\//.test(path);
    }

    return true;
  }catch{return false;}
}
