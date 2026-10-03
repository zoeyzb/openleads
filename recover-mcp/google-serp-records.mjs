function decodeHtml(value=""){
  return String(value||"")
    .replace(/&amp;/gi,"&")
    .replace(/&quot;/gi,'"')
    .replace(/&#39;|&apos;/gi,"'")
    .replace(/&lt;/gi,"<")
    .replace(/&gt;/gi,">")
    .replace(/&nbsp;|&#160;/gi," ");
}
function stripHtml(value=""){
  return decodeHtml(String(value||"")
    .replace(/<script\b[\s\S]*?<\/script>/gi," ")
    .replace(/<style\b[\s\S]*?<\/style>/gi," ")
    .replace(/<[^>]+>/g," "))
    .replace(/\s+/g," ")
    .trim();
}
function destinationFromHref(rawHref=""){
  const raw=decodeHtml(rawHref).trim();
  if(!raw||/^(?:javascript:|mailto:|tel:|#)/i.test(raw))return "";
  try{
    if(/^https?:\/\//i.test(raw)){
      const direct=new URL(raw);
      const host=direct.hostname.toLowerCase().replace(/^www\./,"");
      if(host!=="google.com"&&!host.endsWith(".google.com"))return direct.href;
      if(/\/url$/i.test(direct.pathname)){
        const q=direct.searchParams.get("q")||direct.searchParams.get("url")||"";
        if(q&&/^https?:\/\//i.test(q))return new URL(q).href;
      }
      return "";
    }
    const google=new URL(raw,"https://www.google.com");
    if(!/\/url$/i.test(google.pathname))return "";
    const q=google.searchParams.get("q")||google.searchParams.get("url")||"";
    if(!q||!/^https?:\/\//i.test(q))return "";
    return new URL(q).href;
  }catch{return "";}
}

/**
 * Extract Google result URL + visible card text.
 *
 * This is intentionally presentation-agnostic: Google's class names move, so
 * each outbound result anchor is paired with a bounded chunk ending at the
 * next outbound result anchor. The downstream headcount policy still requires
 * trusted host + strong firm identity + exact phone for broad listing pages.
 */
export function googleResultRecords(html=""){
  const raw=String(html||"");
  const anchors=[];
  const re=/<a\b[^>]*href=["']([^"']+)["'][^>]*>[\s\S]{0,1600}?<\/a>/gi;
  for(const m of raw.matchAll(re)){
    const url=destinationFromHref(m[1]);
    if(!url)continue;
    const host=(()=>{try{return new URL(url).hostname.toLowerCase().replace(/^www\./,"");}catch{return "";}})();
    if(!host||host==="google.com"||host.endsWith(".google.com"))continue;
    anchors.push({index:m.index||0,end:(m.index||0)+m[0].length,url});
  }
  const out=[];
  const seen=new Set();
  for(let i=0;i<anchors.length;i++){
    const item=anchors[i];
    if(seen.has(item.url))continue;
    const next=anchors[i+1]?.index??Math.min(raw.length,item.end+2600);
    const start=Math.max(0,item.index-300);
    const end=Math.min(raw.length,Math.max(item.end+400,Math.min(next,item.end+2600)));
    const text=stripHtml(raw.slice(start,end)).slice(0,1800);
    if(!text)continue;
    out.push({url:item.url,text});
    seen.add(item.url);
    if(out.length>=20)break;
  }
  return out;
}
