import { createClient } from "redis";

const REDIS_URL=process.env.ACQUISITION_REDIS_URL||process.env.REDIS_URL||"";
if(!REDIS_URL) throw new Error("ACQUISITION_REDIS_URL or REDIS_URL required");

const redis=createClient({url:REDIS_URL});
redis.on("error",e=>console.error("redis_error",String(e?.message||e)));
await redis.connect();

function groupKey(key=""){
  if(/^recover:acq:[^:]+:raw$/.test(key)) return "recover:acq:*:raw";
  if(/^recover:acq:[^:]+:results$/.test(key)) return "recover:acq:*:results";
  if(/^recover:acq:[^:]+:lease$/.test(key)) return "recover:acq:*:lease";
  if(/^recover:acq:[^:]+$/.test(key)) return "recover:acq:*:job";
  if(key.startsWith("recover:coverage:")) return "recover:coverage:*";
  if(key.startsWith("recover:leadstore:qualified")) return "recover:leadstore:qualified";
  if(key.startsWith("recover:leadstore:")) return "recover:leadstore:*";
  if(key.startsWith("recover:batch:")) return "recover:batch:*";
  if(key.startsWith("recover:yield:")) return "recover:yield:*";
  if(key.startsWith("recover:sheet:")) return "recover:sheet:*";
  if(key.startsWith("recover:controller:")) return "recover:controller:*";
  if(key.startsWith("recover:maps:")) return "recover:maps:*";
  return key.split(":").slice(0,3).join(":")||"(other)";
}

const info=await redis.sendCommand(["INFO","memory"]);
console.log(JSON.stringify({event:"redis_memory_info",info:String(info).split("\n").filter(x=>/^(used_memory:|used_memory_human:|used_memory_rss:|used_memory_peak:|used_memory_dataset:|mem_fragmentation_ratio:|maxmemory:|maxmemory_human:)/.test(x.trim()))}));

const groups=new Map();
let cursor="0", scanned=0;
do{
  const page=await redis.scan(cursor,{COUNT:1000});
  cursor=String(page.cursor);
  const keys=page.keys||[];
  scanned+=keys.length;
  for(let i=0;i<keys.length;i+=200){
    const chunk=keys.slice(i,i+200);
    const multi=redis.multi();
    for(const key of chunk) multi.memoryUsage(key);
    const sizes=await multi.exec();
    for(let j=0;j<chunk.length;j++){
      const key=chunk[j];
      const bytes=Number(sizes?.[j]||0);
      const group=groupKey(key);
      const current=groups.get(group)||{keys:0,bytes:0,maxKeyBytes:0,maxKey:""};
      current.keys++;
      current.bytes+=bytes;
      if(bytes>current.maxKeyBytes){current.maxKeyBytes=bytes;current.maxKey=key;}
      groups.set(group,current);
    }
  }
  if(scanned%10000<1000) console.log(JSON.stringify({event:"redis_memory_audit_progress",scanned}));
}while(cursor!=="0");

const top=[...groups.entries()]
  .map(([group,v])=>({group,...v,mb:Number((v.bytes/1024/1024).toFixed(2))}))
  .sort((a,b)=>b.bytes-a.bytes);

console.log(JSON.stringify({event:"redis_memory_audit_complete",scanned,top:top.slice(0,40)}));
await redis.quit();
