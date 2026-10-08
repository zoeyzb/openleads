export async function claimSetBatch(redis,setKey,count){
  if(!redis?.sCard||!redis?.sRandMemberCount||!redis?.sRem)throw new Error("redis set primitives required");
  const requested=Math.max(1,Math.floor(Number(count)||1));
  const cardinality=await redis.sCard(setKey);
  if(cardinality<=0)return [];
  const target=Math.min(requested,cardinality);
  const members=await redis.sRandMemberCount(setKey,target);
  const values=Array.isArray(members)?members:(members?[members]:[]);
  const unique=[...new Set(values.filter(Boolean))].slice(0,target);
  if(unique.length)await redis.sRem(setKey,unique);
  return unique;
}
