import { createHash } from "node:crypto";

const clampInt=(value,min,max,fallback)=>{
  const n=Number(value);
  if(!Number.isFinite(n)) return fallback;
  return Math.max(min,Math.min(max,Math.floor(n)));
};

export function deriveSchedulerCapacity({
  workerCount=4,
  mapsLaneCount=6,
  queueHighWater,
  seedBatchSize,
}={}){
  const workers=clampInt(workerCount,1,32,4);
  const lanes=clampInt(mapsLaneCount,1,32,6);
  const shardCount=Math.max(workers,lanes);
  const derivedQueue=Math.min(288,Math.max(72,shardCount*24));
  const derivedSeed=Math.min(72,Math.max(18,shardCount*6));
  return {
    workerCount:workers,
    mapsLaneCount:lanes,
    queueHighWater:clampInt(queueHighWater,1,288,derivedQueue),
    seedBatchSize:clampInt(seedBatchSize,1,72,derivedSeed),
    shardCount,
  };
}

export function shardIdForArea(area={},shardCount=1){
  const count=clampInt(shardCount,1,64,1);
  const stable=[area.partition_state||area.state||"",area.partition_city||area.city||"",area.partition_zip||area.zip||""].join("|").toLowerCase();
  const digest=createHash("sha256").update(stable).digest();
  const bucket=digest.readUInt32BE(0)%count;
  return `shard-${String(bucket+1).padStart(2,"0")}-of-${String(count).padStart(2,"0")}`;
}
