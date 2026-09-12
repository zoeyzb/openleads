export async function sampleSetMembers(redis,key,count){
  const raw=await redis.sendCommand(['SRANDMEMBER',String(key),String(Math.max(1,Number(count)||1))]);
  if(Array.isArray(raw)) return raw.filter(Boolean).map(String);
  return raw?[String(raw)]:[];
}
