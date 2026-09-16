import { createClient } from 'redis';
import { pathToFileURL } from 'node:url';

export const CONTROLLER_KEY='recover:controller:us-core-home-service:v2';

export function nextControllerState(state={}) {
  return {...state,cursor:'0'};
}

export async function resetControllerCursor(redis) {
  const before=await redis.hGetAll(CONTROLLER_KEY);
  await redis.hSet(CONTROLLER_KEY,{cursor:'0'});
  const after=await redis.hGetAll(CONTROLLER_KEY);
  console.log(JSON.stringify({event:'controller_cursor_reset',before,after}));
  return {before,after};
}

async function main(){
  const url=process.env.ACQUISITION_REDIS_URL||'';
  if(!url) throw new Error('ACQUISITION_REDIS_URL required');
  const redis=createClient({url});
  redis.on('error',e=>console.error('Redis error',e));
  await redis.connect();
  try { await resetControllerCursor(redis); }
  finally { await redis.quit(); }
}

if(import.meta.url===pathToFileURL(process.argv[1]||'').href) await main();
