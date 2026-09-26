// Railway watches this runtime shim so acquisition resilience fixes deploy immediately.
// 2026-09-18: force base acquisition-worker rebuild after skipped/failed deployment.
// 2026-09-17: million-target throughput patch: keep nationwide Maps results state-scoped instead of exact-city scoped.
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const LEGACY_FAST_WAIT = "const deadline=Date.now()+(fastProfile ? 90*1000 : 20*60*1000);";
export const RESILIENT_FAST_WAIT = "const requestedMaxSeconds=Number(acquisition?.maps_round_max_time_seconds||acquisition?.max_time_seconds||60);\n  const backendMinimumSeconds=180;\n  const fastWaitMs=(Math.max(backendMinimumSeconds,requestedMaxSeconds)+45)*1000;\n  const deadline=Date.now()+(fastProfile ? fastWaitMs : 20*60*1000);";

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
    if (await redis.exists(mapsLaneCooldownKey(url))) return;
    let failures=Number(await redis.get(mapsLaneFailureKey(url))||0);
    let adaptiveSeconds=seconds;
    if (seconds==null) {
      failures=await redis.incr(mapsLaneFailureKey(url));
      await redis.expire(mapsLaneFailureKey(url),900);
      adaptiveSeconds=Math.min(120,15*(2**Math.min(3,Math.max(0,failures-1))));
    }
    await redis.set(mapsLaneCooldownKey(url),"1",{EX:adaptiveSeconds});
    console.warn("Maps lane cooldown",url,"failures",failures,"seconds",adaptiveSeconds);
  } catch {}
}
async function clearMapsLaneFailure(url) {
  if (!url) return;
  try { await redis.del(mapsLaneFailureKey(url),mapsLaneCooldownKey(url)); } catch {}
}`;

export const LEGACY_TIMEOUT_COOLDOWN = 'if (fastProfile) await markMapsLaneUnavailable(mapsBase,75);';
export const ADAPTIVE_TIMEOUT_COOLDOWN = 'if (fastProfile) await markMapsLaneUnavailable(mapsBase);';

export const LEGACY_MAPS_DONE = `console.log("Acquisition maps done", id, mapsJobId);`;
export const RESILIENT_MAPS_DONE = `await clearMapsLaneFailure(mapsBase);\n      console.log("Acquisition maps done", id, mapsJobId);`;

export const LEGACY_STATUS_FAILURE = [
  "    } catch (error) {",
  "      const msg=String(error?.message||error);",
  "      if (/\\b404\\b|not found/i.test(msg)) {",
  "        throw new Error(`Maps job ${jobId} lost after runtime restart`);",
  "      }",
  "      throw error;",
  "    }",
].join("\n");

export const RESILIENT_STATUS_FAILURE = [
  "    } catch (error) {",
  "      const msg=String(error?.message||error);",
  "      if (/\\b404\\b|not found/i.test(msg)) {",
  "        throw new Error(`Maps job ${jobId} lost after runtime restart`);",
  "      }",
  "      if (isRetryableError(error)) {",
  "        console.warn(\"Maps status temporarily unavailable; keeping job alive\",jobId,msg);",
  "        await sleep(2000);",
  "        continue;",
  "      }",
  "      throw error;",
  "    }",
].join("\n");

export const LEGACY_LOCATION_MATCH = `function matchesAcquisitionLocation(lead, job) {
  return isFastNyMilestoneJob(job) ? matchesFastNyState(lead) : matchesRequestedLocation(lead,job.location);
}`;

export const CITY_SCOPED_LOCATION_MATCH = `function matchesAcquisitionLocation(lead, job) {
  if (isFastNyMilestoneJob(job)) return matchesFastNyState(lead);
  if (String(job?.search_profile||"")==="core-home-service") {
    const requestedState=normalizeText(job?.partition_state||"");
    const requestedCity=normalizeText(job?.partition_city||"");
    const requestedZip=String(job?.partition_zip||job?.source_zip||"").replace(/\\D/g,"").slice(0,5);
    const locationText=String(job?.location||"");
    const zipScoped=Boolean(requestedZip && new RegExp("^\\\\s*"+requestedZip+"\\\\b").test(locationText));
    const leadRegion=normalizeText(lead.region||lead.state||lead.state_code||lead.province||"");
    const leadCity=normalizeText(lead.city||lead.locality||lead.town||"");
    const leadAddressRaw=String(lead.address||lead.full_address||lead.formatted_address||"");
    const leadAddress=normalizeText(leadAddressRaw);
    const leadZip=String(lead.postal_code||lead.zip||lead.zip_code||"").replace(/\\D/g,"").slice(0,5);
    const stateOk=!requestedState || (leadRegion
      ? leadRegion===requestedState || leadRegion.split(" ").includes(requestedState)
      : new RegExp("\\\\b"+requestedState.replace(/[^a-z]/g,"")+"\\\\b").test(leadAddress));
    if (!stateOk) return false;
    if (requestedCity) {
      if (leadCity) return leadCity===requestedCity;
      if (leadAddress.includes(requestedCity)) return true;
    }
    const sourceLat=Number(job?.source_latitude);
    const sourceLon=Number(job?.source_longitude);
    const leadLat=Number(lead.latitude||lead.lat);
    const leadLon=Number(lead.longitude||lead.lng||lead.lon);
    if (Number.isFinite(sourceLat)&&Number.isFinite(sourceLon)&&Number.isFinite(leadLat)&&Number.isFinite(leadLon)) {
      const toRad=d=>d*Math.PI/180;
      const dLat=toRad(leadLat-sourceLat);
      const dLon=toRad(leadLon-sourceLon);
      const a=Math.sin(dLat/2)**2+Math.cos(toRad(sourceLat))*Math.cos(toRad(leadLat))*Math.sin(dLon/2)**2;
      const miles=3958.8*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
      if (miles<=25) return true;
    }
    if (zipScoped) {
      if (leadZip) return leadZip===requestedZip;
      const addressZip=(leadAddressRaw.match(/\\b\\d{5}(?:-\\d{4})?\\b/)||[])[0]||"";
      if (addressZip) return addressZip.slice(0,5)===requestedZip;
    }
    if (!requestedCity) return matchesRequestedLocation(lead,job.location);
    return false;
  }
  return matchesRequestedLocation(lead,job.location);
}`;

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

function patchRawRetention(source) {
  const signature = "async function replaceList(key,values) {";
  const expiry = "await redis.expire(key,JOB_TTL);";
  const rawWrite = "await replaceList(rawKey(id),allRaw);";
  const present = [signature, expiry, rawWrite].map(marker => source.includes(marker));
  if (!present.some(Boolean)) return source;
  if (!present.every(Boolean)) throw new Error("acquisition raw retention contract is only partially present");

  return source
    .replace(
      signature,
      "const RAW_TTL=Number(process.env.ACQUISITION_RAW_TTL_SECONDS||7200);\nasync function replaceList(key,values,ttlSeconds=JOB_TTL) {"
    )
    .replace(expiry, "await redis.expire(key,ttlSeconds);")
    .replace(rawWrite, "await replaceList(rawKey(id),allRaw,RAW_TTL);");
}

export function patchAcquisitionWorkerSource(source) {
  const waitMatches = source.split(LEGACY_FAST_WAIT).length - 1;
  const cooldownMatches = source.split(LEGACY_LANE_COOLDOWN).length - 1;
  const doneMatches = source.split(LEGACY_MAPS_DONE).length - 1;
  const statusFailureMatches = source.split(LEGACY_STATUS_FAILURE).length - 1;
  const timeoutCooldownMatches = source.split(LEGACY_TIMEOUT_COOLDOWN).length - 1;
  const locationMatches = source.split(LEGACY_LOCATION_MATCH).length - 1;
  const loopMatches = source.split(LEGACY_WORKER_LOOP).length - 1;
  const hasNativeConcurrentPriorityLoop = source.includes("async function acquisitionWorkerLoop(slot)") &&
    source.includes("US_CITY_PRIORITY_QUEUE");
  if (waitMatches !== 1) throw new Error(`expected exactly one legacy fast Maps wait expression, found ${waitMatches}`);
  if (cooldownMatches !== 1) throw new Error(`expected exactly one legacy Maps cooldown block, found ${cooldownMatches}`);
  if (doneMatches !== 1) throw new Error(`expected exactly one Maps completion marker, found ${doneMatches}`);
  if (statusFailureMatches !== 1) throw new Error(`expected exactly one Maps status failure block, found ${statusFailureMatches}`);
  if (timeoutCooldownMatches !== 1) throw new Error(`expected exactly one timeout cooldown marker, found ${timeoutCooldownMatches}`);
  if (locationMatches !== 1) throw new Error(`expected exactly one acquisition location matcher, found ${locationMatches}`);
  if (loopMatches !== 1 && !(loopMatches===0 && hasNativeConcurrentPriorityLoop)) {
    throw new Error(`expected legacy worker loop or native concurrent priority loop, found ${loopMatches}`);
  }
  const resilient = source
    .replace(LEGACY_FAST_WAIT, RESILIENT_FAST_WAIT)
    .replace(LEGACY_LANE_COOLDOWN, ADAPTIVE_LANE_COOLDOWN)
    .replace(LEGACY_MAPS_DONE, RESILIENT_MAPS_DONE)
    .replace(LEGACY_STATUS_FAILURE, RESILIENT_STATUS_FAILURE)
    .replace(LEGACY_TIMEOUT_COOLDOWN, ADAPTIVE_TIMEOUT_COOLDOWN)
    .replace(LEGACY_LOCATION_MATCH, CITY_SCOPED_LOCATION_MATCH)
    .replace(LEGACY_WORKER_LOOP, CONCURRENT_WORKER_LOOP);
  return patchRawRetention(resilient);
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
