export function shouldPauseGenericDiscovery({
  unresolvedCallable=0,
  rawQueue=0
}={}, {
  unresolvedThreshold=1000,
  rawQueueHighWater=64
}={}){
  const unresolved=Math.max(0,Number(unresolvedCallable)||0);
  const queue=Math.max(0,Number(rawQueue)||0);
  const threshold=Math.max(1,Number(unresolvedThreshold)||1000);
  const highWater=Math.max(1,Number(rawQueueHighWater)||64);
  return unresolved>=threshold||queue>=highWater;
}
