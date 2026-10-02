export async function alignEligibleToReady(redis,{eligibleSet,readySet}={}){
  if(!redis?.sInterStore)throw new Error("redis sInterStore required");
  if(!eligibleSet||!readySet)throw new Error("eligibleSet and readySet required");
  // Atomic intersection avoids the old delete/rebuild race: a newly-qualified
  // lead added before this command exists in both sets and survives; one added
  // after this command is appended normally by the live worker.
  return redis.sInterStore(eligibleSet,[eligibleSet,readySet]);
}
