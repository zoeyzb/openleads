import { hostOf } from './email-enrichment-evidence.mjs';

function absoluteUrl(base,href){
  try{return new URL(href,base).toString();}catch{return '';}
}
function sameHost(a,b){
  const ah=hostOf(a),bh=hostOf(b);
  return Boolean(ah&&bh&&(ah===bh||ah.endsWith('.'+bh)||bh.endsWith('.'+ah)));
}
export function discoverContactUrls(result={}){
  const base=String(result.url||result.href||'').trim();
  if(!/^https?:\/\//i.test(base))return [];
  const scrape=result.scrape||{};
  const texts=[
    String(scrape.markdown||''),
    String(scrape.fit_markdown||''),
    String(scrape.raw_html||scrape.html||scrape.content||'')
  ];
  const found=new Set();
  const add=(href,label='')=>{
    const url=absoluteUrl(base,href);
    if(!url||!sameHost(base,url))return;
    const hay=(String(label)+' '+url).toLowerCase();
    if(!/(contact|about|support|team|staff|company|reach-us|get-in-touch)/i.test(hay))return;
    const u=new URL(url);u.hash='';
    found.add(u.toString());
  };
  for(const text of texts){
    for(const m of text.matchAll(/\[([^\]]{0,80})\]\((https?:\/\/[^\s)]+|\/[^\s)]+)\)/g))add(m[2],m[1]);
    for(const m of text.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi))add(m[1],m[2].replace(/<[^>]+>/g,' '));
  }
  return [...found].slice(0,3);
}