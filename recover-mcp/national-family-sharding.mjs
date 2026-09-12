export const FAMILY_SHARDS=[
  {key:'heating_cooling',queryIndex:0,label:'heating and cooling contractor'},
  {key:'ac_repair',queryIndex:1,label:'air conditioning repair service'},
  {key:'hvac',queryIndex:2,label:'HVAC contractor'},
  {key:'heating_contractor',queryIndex:3,label:'heating contractor'},
  {key:'ac_service',queryIndex:4,label:'AC repair service'},
  {key:'furnace',queryIndex:5,label:'furnace repair service'},
  {key:'boiler',queryIndex:6,label:'boiler repair service'},
  {key:'duct',queryIndex:7,label:'air duct contractor'},
  {key:'ventilation',queryIndex:8,label:'ventilation contractor'},
  {key:'plumbing',queryIndex:9,label:'plumbing contractor'},
  {key:'plumber',queryIndex:10,label:'plumber'},
  {key:'refrigeration',queryIndex:11,label:'refrigeration contractor'},
  {key:'residential_hvac',queryIndex:12,label:'residential heating and cooling'},
  {key:'commercial_hvac',queryIndex:13,label:'commercial heating and cooling'},
  {key:'emergency_hvac_plumbing',queryIndex:14,label:'emergency plumbing and HVAC'},
  {key:'hvac_plumbing',queryIndex:15,label:'heating cooling plumbing contractor'},
  {key:'furnace_boiler',queryIndex:16,label:'furnace boiler contractor'},
  {key:'ac_installation',queryIndex:17,label:'air conditioning installation'},
  {key:'heating_repair',queryIndex:18,label:'heating repair service'},
  {key:'duct_cleaning',queryIndex:19,label:'duct cleaning service'},
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
