export const LATE_PASS_SERVICE_FAMILIES=[
  "HVAC contractor",
  "heating contractor",
  "air conditioning repair service",
  "furnace repair service",
  "boiler repair service",
  "plumbing contractor",
  "plumber",
  "heat pump contractor",
  "water heater repair service",
  "drain cleaning service",
  "sewer repair service",
  "duct cleaning service",
  "ventilation contractor",
  "refrigeration contractor",
  "geothermal heating contractor",
  "indoor air quality service",
  "thermostat installation service",
  "ductless HVAC contractor",
  "mini split installation service",
  "emergency plumber",
  "plumbing repair service",
  "water heater contractor",
  "drain service",
  "sewer service"
];

function stableHash(value=""){
  let hash=0;
  for(const ch of String(value||"")) hash=(hash*31+ch.charCodeAt(0))>>>0;
  return hash>>>0;
}

export function latePassServiceFamily(area={},coveragePass=5){
  const pass=Math.max(1,Number(coveragePass)||1);
  const state=String(area.partition_state||area.state||"").trim().toLowerCase();
  const city=String(area.partition_city||area.city||"").trim().toLowerCase();
  const base=stableHash(`${state}|${city}`);
  const offset=Math.max(0,pass-5);
  return LATE_PASS_SERVICE_FAMILIES[(base+offset*7)%LATE_PASS_SERVICE_FAMILIES.length];
}
