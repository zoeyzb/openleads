const BROWSER_UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

export function researchRequestHeaders(url=""){
  const value=String(url||"");
  let host="";
  try{host=new URL(value).hostname.toLowerCase().replace(/^www\./,"");}catch{}
  const browserLike=
    /https?:\/\/(?:www\.)?(?:google|bing)\.com\//i.test(value) ||
    /https?:\/\/html\.duckduckgo\.com\//i.test(value) ||
    /https?:\/\/apps\.calbar\.ca\.gov\/attorney\//i.test(value) ||
    ["lawyers.com","lawyer.com","martindale.com","findlaw.com","justia.com"].some(d=>host===d||host.endsWith("."+d));
  return browserLike?{
    "user-agent":BROWSER_UA,
    "accept":"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language":"en-US,en;q=0.9",
    "cache-control":"no-cache",
    "pragma":"no-cache",
    "upgrade-insecure-requests":"1"
  }:{
    "user-agent":"Mozilla/5.0 (compatible; RecoverResearch/1.0)",
    "accept":"text/html,application/xhtml+xml"
  };
}
