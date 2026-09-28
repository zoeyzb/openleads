import { createClient } from "redis";

const url=process.env.ACQUISITION_REDIS_URL||"";
if(!url)throw new Error("ACQUISITION_REDIS_URL required");
const r=createClient({url});
await r.connect();

let law=0,noWeb=0,noWebEmail=0;
for await(const pg of r.hScanIterator("recover:leadstore:qualified",{COUNT:500})){
  for(const x of (Array.isArray(pg)?pg:[pg])){
    if(!x?.value)continue;
    let o;try{o=JSON.parse(x.value)||{};}catch{continue;}
    const isLaw=String(o.search_profile||"")==="law-firm"||String(o.industry||"").toUpperCase()==="LAW_FIRM";
    if(!isLaw)continue;
    law++;
    const hasWebsite=/^https?:\/\//i.test(String(o.website||"").trim());
    if(hasWebsite)continue;
    noWeb++;
    const emails=[...(Array.isArray(o.emails)?o.emails:[]),o.email].filter(Boolean);
    if(emails.length)noWebEmail++;
  }
}
const payload={
  law,noWeb,noWebEmail,
  hash:await r.hLen("recover:leadstore:qualified"),
  q3:await r.sCard("recover:law-firm:qualified:v3"),
  p3:await r.sCard("recover:law-firm:enrich-pending:v3"),
  p2:await r.sCard("recover:law-firm:enrich-pending:v2"),
  priority:await r.sCard("recover:law-firm:enrich-priority:v3"),
  at:new Date().toISOString()
};
await r.set("recover:diag:law-redis-source",JSON.stringify(payload),{EX:3600});
console.log(JSON.stringify(payload));
await r.quit();
