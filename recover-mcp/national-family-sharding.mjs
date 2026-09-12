export const FAMILY_SHARDS=[
  {key:'hvac',queryIndex:2,label:'HVAC contractor'},
  {key:'plumbing',queryIndex:9,label:'plumbing contractor'},
  {key:'furnace',queryIndex:5,label:'furnace repair service'},
  {key:'boiler',queryIndex:6,label:'boiler repair service'},
  {key:'refrigeration',queryIndex:11,label:'refrigeration contractor'},
  {key:'duct',queryIndex:7,label:'air duct contractor'},
  {key:'ventilation',queryIndex:8,label:'ventilation contractor'},
];

function workerHash(value){
  let hash=0;
  for(const ch of String(value||'')) hash=(hash*31+ch.charCodeAt(0))>>>0;
  return hash;
}

export function queryPassForIndex(location,queryIndex,prefix='us-core-family-v4'){
  const desired=Number(queryIndex);
  for(let nonce=0;nonce<500;nonce++){
    const pass=`${prefix}-q${desired}-n${nonce}`;
    if(workerHash(`${location}|${pass}`)%20===desired) return pass;
  }
  throw new Error(`unable to derive pass for query index ${desired}`);
}

export function workUnitForCursor(areas,cursor){
  if(!Array.isArray(areas)||!areas.length) return null;
  const normalized=Math.max(0,Number(cursor)||0);
  const areaIndex=Math.floor(normalized/FAMILY_SHARDS.length);
  if(areaIndex>=areas.length) return null;
  const family=FAMILY_SHARDS[normalized%FAMILY_SHARDS.length];
  return {area:areas[areaIndex],family,areaIndex,cursor:normalized};
}
