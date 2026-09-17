import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const IMPORT_LINE="import { orderControllerAreas } from './us-hvac-area-order.mjs';";

export function patchControllerSource(source='') {
  let out=String(source);
  if (out.includes('return orderControllerAreas(out);')) return out;

  if (!out.includes(IMPORT_LINE)) {
    const anchor=/import\s+\{\s*deriveSchedulerCapacity\s*,\s*shardIdForArea\s*\}\s+from\s+['"]\.\/nationwide-shard-scheduler\.mjs['"];?\s*\n/;
    if (!anchor.test(out)) throw new Error('controller import anchor missing');
    out=out.replace(anchor,match=>match+IMPORT_LINE+'\n');
  }

  const returnPattern=/return\s+partitionNationwideAreas\s*\(\s*out\s*\)\s*;?/;
  if (!returnPattern.test(out)) throw new Error('controller area-order marker missing');
  return out.replace(returnPattern,'return orderControllerAreas(out);');
}

async function main(){
  const sourceUrl=new URL('./us-hvac-controller-v3.mjs',import.meta.url);
  const runtimeUrl=new URL('./us-hvac-controller-v3.runtime.mjs',import.meta.url);
  const source=fs.readFileSync(sourceUrl,'utf8');
  fs.writeFileSync(runtimeUrl,patchControllerSource(source));
  await import(pathToFileURL(runtimeUrl.pathname).href+`?v=${Date.now()}`);
}

if (import.meta.url===pathToFileURL(process.argv[1]||'').href) await main();
