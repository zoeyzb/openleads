import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const LEGACY_FAST_WAIT = "const deadline=Date.now()+(fastProfile ? 90*1000 : 20*60*1000);";
export const RESILIENT_FAST_WAIT = "const requestedMaxSeconds=Number(acquisition?.maps_round_max_time_seconds||acquisition?.max_time_seconds||60);\n  const fastWaitMs=(Math.max(180,requestedMaxSeconds)+45)*1000;\n  const deadline=Date.now()+(fastProfile ? fastWaitMs : 20*60*1000);";

export function patchAcquisitionWorkerSource(source) {
  const matches = source.split(LEGACY_FAST_WAIT).length - 1;
  if (matches !== 1) {
    throw new Error(`expected exactly one legacy fast Maps wait expression, found ${matches}`);
  }
  return source.replace(LEGACY_FAST_WAIT, RESILIENT_FAST_WAIT);
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
