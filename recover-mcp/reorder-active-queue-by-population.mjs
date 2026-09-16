import { createClient } from 'redis';

const REDIS_URL=process.env.ACQUISITION_REDIS_URL||'';
if(!REDIS_URL) throw new Error('ACQUISITION_REDIS_URL required');

const QUEUE='recover:acquisition:queue';
const lua=String.raw`
local q=KEYS[1]
local ids=redis.call('LRANGE',q,0,-1)
local items={}
for i,id in ipairs(ids) do
  local raw=redis.call('GET','recover:acq:'..id)
  local pop=0
  if raw then
    local ok,j=pcall(cjson.decode,raw)
    if ok and j and j['source_population'] then pop=tonumber(j['source_population']) or 0 end
  end
  table.insert(items,{id=id,pop=pop,idx=i})
end

table.sort(items,function(a,b)
  if a.pop==b.pop then return a.idx<b.idx end
  return a.pop<b.pop
end)

redis.call('DEL',q)
for _,x in ipairs(items) do redis.call('RPUSH',q,x.id) end

local nextJobs={}
local start=math.max(1,#items-9)
for i=#items,start,-1 do
  table.insert(nextJobs,{id=items[i].id,pop=items[i].pop})
end
return cjson.encode({count=#items,next=nextJobs,min=(#items>0 and items[1].pop or 0),max=(#items>0 and items[#items].pop or 0)})
`;

const redis=createClient({url:REDIS_URL});
redis.on('error',e=>console.error('Redis error',e));
await redis.connect();
try {
  const before=await redis.lLen(QUEUE);
  const result=await redis.eval(lua,{keys:[QUEUE],arguments:[]});
  const after=await redis.lLen(QUEUE);
  if(before!==after) throw new Error(`queue length changed during reorder: ${before} -> ${after}`);
  console.log(JSON.stringify({event:'active_queue_population_reordered',before,after,result:JSON.parse(String(result))}));
} finally {
  await redis.quit();
}
