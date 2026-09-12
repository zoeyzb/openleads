// Railway watches this runtime shim so acquisition resilience fixes deploy immediately.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const LEGACY_FAST_WAIT = "const deadline=Date.now()+(fastProfile ? 90*1000 : 20*60*1000);";
export const RESILIENT_FAST_WAIT = "const requestedMaxSeconds=Number(acquisition?.maps_round_max_time_seconds||acquisition?.max_time_seconds||60);\n  const fastWaitMs=(Math.max(180,requestedMaxSeconds)+45)*1000;\n  const deadline=Date.now()+(fastProfile ? fastWaitMs : 20*60*1000);";

export const LEGACY_LANE_COOLDOWN = `function mapsLaneCooldownKey(url) {
  return "recover:maps:lane:cooldown:"+Buffer.from(String(url||"")).toString("base64url");
}
async function markMapsLaneUnavailable(url, seconds=75) {
  if (!url) return;
  try { await redis.set(mapsLaneCooldownKey(url),"1",{EX:seconds}); } catch {}
}`;

export const ADAPTIVE_LANE_COOLDOWN = `function mapsLaneCooldownKey(url) {
  return "recover:maps:lane:cooldown:"+Buffer.from(String(url||"")).toString("base64url");
}
function mapsLaneFailureKey(url) {
  return "recover:maps:lane:failures:"+Buffer.from(String(url||"")).toString("base64url");
}
async function markMapsLaneUnavailable(url, seconds=null) {
  if (!url) return;
  try {
    const failures=await redis.incr(mapsLaneFailureKey(url));
    await redis.expire(mapsLaneFailureKey(url),1800);
    const adaptiveSeconds=seconds==null ? Math.min(900,75*(2**Math.min(4,Math.max(0,failures-1)))) : seconds;
    await redis.set(mapsLaneCooldownKey(url),"1",{EX:adaptiveSeconds});
    console.warn("Maps lane cooldown",url,"failures",failures,"seconds",adaptiveSeconds);
  } catch {}
}
async function clearMapsLaneFailure(url) {
  if (!url) return;
  try { await redis.del(mapsLaneFailureKey(url),mapsLaneCooldownKey(url)); } catch {}
}`;

export const LEGACY_MAPS_DONE = `console.log("Acquisition maps done", id, mapsJobId);`;
export const RESILIENT_MAPS_DONE = `await clearMapsLaneFailure(mapsBase);\n      console.log("Acquisition maps done", id, mapsJobId);`;
export const LEGACY_QUEUE_POLL = `const item=await redis.brPop(["recover:acquisition:queue:ny-priority","recover:acquisition:queue"],5);`;

export const LEGACY_WORKER_LOOP = `while (!shuttingDown) {
  try {
    const item=await redis.brPop(["recover:acquisition:queue:ny-priority","recover:acquisition:queue"],5);
    if (shuttingDown) break;
    const id=item?.element||item;
    if (!id) continue;
    await processAcquisition(String(id));
  } catch (error) {
    console.error("Worker loop error",error);
    await sleep(5000);
  }
}`;

export const CONCURRENT_WORKER_LOOP = `const workerConcurrency=Math.max(1,Math.min(4,Number(process.env.ACQUISITION_WORKER_CONCURRENCY||2)));
console.log("Acquisition worker concurrency",workerConcurrency);
async function acquisitionWorkerLoop(slot){
  while (!shuttingDown) {
    try {
      const item=await redis.brPop(["recover:acquisition:queue:ny-priority","recover:acquisition:queue:us-city-priority","recover:acquisition:queue"],5);
      if (shuttingDown) break;
      const id=item?.element||item;
      if (!id) continue;
      await processAcquisition(String(id));
    } catch (error) {
      console.error("Worker loop error","worker slot",slot,error);
      await sleep(5000);
    }
  }
}
await Promise.all(Array.from({length:workerConcurrency},(_,slot)=>acquisitionWorkerLoop(slot+1)));`;

export function patchAcquisitionWorkerSource(source) {
  const waitMatches = source.split(LEGACY_FAST_WAIT).length - 1;
  const cooldownMatches = source.split(LEGACY_LANE_COOLDOWN).length - 1;
  const doneMatches = source.split(LEGACY_MAPS_DONE).length - 1;
  const loopMatches = source.split(LEGACY_WORKER_LOOP).length - 1;
  if (waitMatches !== 1) throw new Error(`expected exactly one legacy fast Maps wait expression, found ${waitMatches}`);
  if (cooldownMatches !== 1) throw new Error(`expected exactly one legacy Maps cooldown block, found ${cooldownMatches}`);
  if (doneMatches !== 1) throw new Error(`expected exactly one Maps completion marker, found ${doneMatches}`);
  if (loopMatches !== 1) throw new Error(`expected exactly one legacy worker loop, found ${loopMatches}`);
  return source
    .replace(LEGACY_FAST_WAIT, RESILIENT_FAST_WAIT)
    .replace(LEGACY_LANE_COOLDOWN, ADAPTIVE_LANE_COOLDOWN)
    .replace(LEGACY_MAPS_DONE, RESILIENT_MAPS_DONE)
    .replace(LEGACY_WORKER_LOOP, CONCURRENT_WORKER_LOOP);
}

export async function runPatchedWorker() {
  const sourceUrl = new URL("./acquisition-worker.mjs", import.meta.url);
  const runtimeUrl = new URL("./.acquisition-worker-runtime.generated.mjs", import.meta.url);
  const source = await readFile(sourceUrl, "utf8");
  const patched = patchAcquisitionWorkerSource(source);
  await writeFile(runtimeUrl, patched, "utf8");
  await import(`${pathToFileURL(runtimeUrl.pathname).href}?v=${Date.now()}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await runPatchedWorker();
}
