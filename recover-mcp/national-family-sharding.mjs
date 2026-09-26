export const FAMILY_SHARDS=[
  {key:'heating_cooling',queryIndex:0,label:"heating and cooling contractor"},
  {key:'ac_repair',queryIndex:1,label:"air conditioning repair service"},
  {key:'hvac',queryIndex:2,label:"HVAC contractor"},
  {key:'heating_contractor',queryIndex:3,label:"heating contractor"},
  {key:'ac_service',queryIndex:4,label:"AC repair service"},
  {key:'furnace',queryIndex:5,label:"furnace repair service"},
  {key:'boiler',queryIndex:6,label:"boiler repair service"},
  {key:'duct',queryIndex:7,label:"air duct contractor"},
  {key:'ventilation',queryIndex:8,label:"ventilation contractor"},
  {key:'plumbing',queryIndex:9,label:"plumbing contractor"},
  {key:'plumber',queryIndex:10,label:"plumber"},
  {key:'refrigeration',queryIndex:11,label:"refrigeration contractor"},
  {key:'residential_hvac',queryIndex:12,label:"residential heating and cooling"},
  {key:'commercial_hvac',queryIndex:13,label:"commercial heating and cooling"},
  {key:'emergency_hvac_plumbing',queryIndex:14,label:"emergency plumbing and HVAC"},
  {key:'hvac_plumbing',queryIndex:15,label:"heating cooling plumbing contractor"},
  {key:'furnace_boiler',queryIndex:16,label:"furnace boiler contractor"},
  {key:'ac_installation',queryIndex:17,label:"air conditioning installation"},
  {key:'heating_repair',queryIndex:18,label:"heating repair service"},
  {key:'duct_cleaning',queryIndex:19,label:"duct cleaning service"},
  {key:'heat_pump',queryIndex:20,label:"heat pump contractor"},
  {key:'heat_pump_repair',queryIndex:21,label:"heat pump repair service"},
  {key:'water_heater_repair',queryIndex:22,label:"water heater repair service"},
  {key:'water_heater_installation',queryIndex:23,label:"water heater installation"},
  {key:'drain_cleaning',queryIndex:24,label:"drain cleaning service"},
  {key:'sewer_repair',queryIndex:25,label:"sewer repair service"},
  {key:'pipe_repair',queryIndex:26,label:"pipe repair service"},
  {key:'geothermal',queryIndex:27,label:"geothermal heating contractor"},
  {key:'indoor_air_quality',queryIndex:28,label:"indoor air quality service"},
  {key:'thermostat_installation',queryIndex:29,label:"thermostat installation service"},
  {key:'hvac_repair',queryIndex:30,label:"HVAC repair service"},
  {key:'air_conditioning_contractor',queryIndex:31,label:"air conditioning contractor"},
  {key:'air_conditioning_service',queryIndex:32,label:"air conditioning service"},
  {key:'residential_hvac_contractor',queryIndex:33,label:"residential HVAC contractor"},
  {key:'commercial_hvac_contractor',queryIndex:34,label:"commercial HVAC contractor"},
  {key:'heating_air_service',queryIndex:35,label:"heating and air conditioning service"},
  {key:'furnace_contractor',queryIndex:36,label:"furnace contractor"},
  {key:'boiler_contractor',queryIndex:37,label:"boiler contractor"},
  {key:'heating_installation',queryIndex:38,label:"heating installation service"},
  {key:'ac_installation_service',queryIndex:39,label:"AC installation service"},
  {key:'ductless_hvac',queryIndex:40,label:"ductless HVAC contractor"},
  {key:'mini_split_installation',queryIndex:41,label:"mini split installation service"},
  {key:'emergency_plumber',queryIndex:42,label:"emergency plumber"},
  {key:'plumbing_repair',queryIndex:43,label:"plumbing repair service"},
  {key:'plumber_24h',queryIndex:44,label:"24 hour plumber"},
  {key:'water_heater_contractor',queryIndex:45,label:"water heater contractor"},
  {key:'drain_service',queryIndex:46,label:"drain service"},
  {key:'sewer_service',queryIndex:47,label:"sewer service"},
  {key:'refrigeration_service',queryIndex:48,label:"refrigeration service"},
  {key:'local_hvac_company',queryIndex:49,label:"local HVAC company"},
  {key:'hvac_service_company',queryIndex:50,label:"HVAC service company"},
  {key:'hvac_repair_contractor',queryIndex:51,label:"HVAC repair contractor"},
  {key:'heating_repair_contractor',queryIndex:52,label:"heating repair contractor"},
  {key:'heating_service_company',queryIndex:53,label:"heating service company"},
  {key:'air_conditioner_repair',queryIndex:54,label:"air conditioner repair"},
  {key:'air_conditioner_service',queryIndex:55,label:"air conditioner service"},
  {key:'ac_service_company',queryIndex:56,label:"AC service company"},
  {key:'furnace_service',queryIndex:57,label:"furnace service"},
  {key:'boiler_service',queryIndex:58,label:"boiler service"},
  {key:'ductwork_contractor',queryIndex:59,label:"ductwork contractor"},
  {key:'ductwork_installation',queryIndex:60,label:"ductwork installation"},
  {key:'mini_split_contractor',queryIndex:61,label:"mini split contractor"},
  {key:'local_plumber',queryIndex:62,label:"local plumber"},
  {key:'plumbing_company',queryIndex:63,label:"plumbing company"},
  {key:'plumbing_service_company',queryIndex:64,label:"plumbing service company"},
  {key:'emergency_plumbing_service',queryIndex:65,label:"emergency plumbing service"},
  {key:'water_heater_service',queryIndex:66,label:"water heater service"},
  {key:'drain_contractor',queryIndex:67,label:"drain contractor"},
  {key:'sewer_contractor',queryIndex:68,label:"sewer contractor"},
];

function workerHash(value){
  let hash=0;
  for(const ch of String(value||'')) hash=(hash*31+ch.charCodeAt(0))>>>0;
  return hash;
}

export function queryPassForIndex(location,queryIndex,prefix='us-core-family-v4'){
  const desired=Number(queryIndex);
  for(let nonce=0;nonce<2000;nonce++){
    const pass=`${prefix}-q${desired}-n${nonce}`;
    if(workerHash(`${location}|${pass}`)%FAMILY_SHARDS.length===desired) return pass;
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
