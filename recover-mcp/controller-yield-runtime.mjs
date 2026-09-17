import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const IMPORT_LINE="import { orderControllerAreas, locationForCoveragePass } from './us-hvac-area-order.mjs';";
const OLD_IMPORT_LINE="import { orderControllerAreas } from './us-hvac-area-order.mjs';";
const MILLION_PASS_MARKER='if(TARGET_TOTAL>=1000000&&coveragePass===1)';

export function patchControllerSource(source='') {
  let out=String(source);

  if (out.includes(OLD_IMPORT_LINE)) {
    out=out.replace(OLD_IMPORT_LINE,IMPORT_LINE);
  } else if (!out.includes(IMPORT_LINE)) {
    const anchor=/import[^\n]+from\s+['"]\.\/nationwide-shard-scheduler\.mjs['"];?\s*\n/;
    if (!anchor.test(out)) throw new Error('controller import anchor missing');
    out=out.replace(anchor,match=>match+IMPORT_LINE+'\n');
  }

  if (!out.includes('return orderControllerAreas(out);')) {
    const returnPattern=/return\s+partitionNationwideAreas\s*\(\s*out\s*\)\s*;?/;
    if (!returnPattern.test(out)) throw new Error('controller area-order marker missing');
    out=out.replace(returnPattern,'return orderControllerAreas(out);');
  }

  if (!out.includes(MILLION_PASS_MARKER)) {
    const statePattern=/(let cursor=Number\(await redis\.hGet\(CONTROLLER_KEY,"cursor"\)\|\|0\);\s*let coveragePass=Math\.max\(1,Number\(await redis\.hGet\(CONTROLLER_KEY,"coverage_pass"\)\|\|1\)\);)/;
    if (!statePattern.test(out)) throw new Error('controller coverage state marker missing');
    out=out.replace(statePattern,`$1\nif(TARGET_TOTAL>=1000000&&coveragePass===1){coveragePass=2;cursor=0;await redis.hSet(CONTROLLER_KEY,{cursor:'0',coverage_pass:'2'});console.log(JSON.stringify({event:'million_target_city_pass',coveragePass,cursor}));}`);
  }

  if (!out.includes('location:locationForCoveragePass(area,coveragePass)')) {
    const locationPattern=/location\s*:\s*area\.location/;
    if (!locationPattern.test(out)) throw new Error('controller job location marker missing');
    out=out.replace(locationPattern,'location:locationForCoveragePass(area,coveragePass)');
  }

  return out;
}

async function main(){
  const sourceUrl=new URL('./us-hvac-controller-v3.mjs',import.meta.url);
  const runtimeUrl=new URL('./us-hvac-controller-v3.runtime.mjs',import.meta.url);
  const source=fs.readFileSync(sourceUrl,'utf8');
  fs.writeFileSync(runtimeUrl,patchControllerSource(source));
  await import(pathToFileURL(runtimeUrl.pathname).href+`?v=${Date.now()}`);
}

if (import.meta.url===pathToFileURL(process.argv[1]||'').href) await main();
