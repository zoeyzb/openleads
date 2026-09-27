import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const IMPORT_LINE="import { orderControllerAreas, locationForCoveragePass } from './us-hvac-area-order.mjs';";
const OLD_IMPORT_LINE="import { orderControllerAreas } from './us-hvac-area-order.mjs';";
const MILLION_PASS_MARKER='if(TARGET_TOTAL>=1000000&&coveragePass<3)';

export function patchControllerSource(source='') {
  let out=String(source);
  if (out.includes(OLD_IMPORT_LINE)) out=out.replace(OLD_IMPORT_LINE,IMPORT_LINE);
  else if (!out.includes(IMPORT_LINE)) {
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
    out=out.replace(statePattern,`$1\nif(TARGET_TOTAL>=1000000&&coveragePass<3){coveragePass=3;cursor=0;await redis.hSet(CONTROLLER_KEY,{cursor:'0',coverage_pass:'3'});console.log(JSON.stringify({event:'million_target_query_refresh_pass',coveragePass,cursor}));}`);
  }
  if (!out.includes('location:locationForCoveragePass(area,coveragePass)')) {
    const locationPattern=/location\s*:\s*area\.location/;
    if (!locationPattern.test(out)) throw new Error('controller job location marker missing');
    out=out.replace(locationPattern,'location:locationForCoveragePass(area,coveragePass)');
  }
  return out;
}

function spawnHelper(script,eventPrefix){
  const child=spawn(process.execPath,[script],{cwd:process.cwd(),env:process.env,stdio:'inherit'});
  child.on('exit',(code,signal)=>console.warn(JSON.stringify({event:`${eventPrefix}_exit`,code,signal})));
  child.on('error',error=>console.warn(JSON.stringify({event:`${eventPrefix}_error`,error:String(error?.message||error)})));
  process.on('SIGTERM',()=>{try{child.kill('SIGTERM')}catch{}});
  process.on('SIGINT',()=>{try{child.kill('SIGINT')}catch{}});
  console.log(JSON.stringify({event:`${eventPrefix}_started`,pid:child.pid}));
  return child;
}

async function startSecondaryDiscoveryChild(){
  if(String(process.env.SECONDARY_DISCOVERY_ENABLED||'1')==='0') return;
  spawnHelper('recover-mcp/secondary-discovery-worker.mjs','secondary_discovery_child');
}

async function startEmailV2Child(){
  if(String(process.env.EMAIL_V2_ENABLED||'1')==='0') return;
  spawnHelper('recover-mcp/secondary-email-enrichment-v2.mjs','email_v2_child');
}

async function main(){
  const sourceUrl=new URL('./us-hvac-controller-v3.mjs',import.meta.url);
  const runtimeUrl=new URL('./us-hvac-controller-v3.runtime.mjs',import.meta.url);
  const source=fs.readFileSync(sourceUrl,'utf8');
  fs.writeFileSync(runtimeUrl,patchControllerSource(source));
  await startSecondaryDiscoveryChild();
  await startEmailV2Child();
  await import(pathToFileURL(runtimeUrl.pathname).href+`?v=${Date.now()}`);
}

if (import.meta.url===pathToFileURL(process.argv[1]||'').href) await main();
// email-v2 rollout marker 2026-09-27 compact-query-v2
// email audit rollout marker 2026-09-27 live-coverage
