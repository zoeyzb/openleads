import { prioritizeAreas } from './national-yield-priority.mjs';

function populationTier(area={}) {
  const p=Number(area?.population||0);
  return p>=25000?0:p>=10000?1:p>=2500?2:3;
}

function cityFirstWithinTier(rows=[]) {
  const first=[];
  const repeats=[];
  const seen=new Set();
  for(const row of rows){
    const cityKey=`${String(row?.state||'').trim().toLowerCase()}|${String(row?.city||'').trim().toLowerCase()}`;
    if(cityKey!=='|' && !seen.has(cityKey)){
      seen.add(cityKey);
      first.push(row);
    }else{
      repeats.push(row);
    }
  }
  return [...first,...repeats];
}

export function locationForCoveragePass(area={},coveragePass=1) {
  const pass=Math.max(1,Number(coveragePass)||1);
  // First two passes stay ZIP-scoped for precision. Later passes switch to one
  // city-level discovery search per city (controller enforces the city claim)
  // so we discover businesses missed by ZIP-ranked Maps results without
  // repeating the same ZIP query forever.
  if(pass>=3){
    const city=String(area?.city||'').trim();
    const state=String(area?.state||'').trim();
    if(city&&state) return `${city}, ${state}`;
  }
  return String(area?.location||[area?.zip,area?.city,area?.state].filter(Boolean).join(' ')).trim();
}

// Preserve population-tier priority, but spend the first coverage wave on new
// cities instead of burning consecutive jobs on multiple ZIPs from one city.
export function orderControllerAreas(rows=[]) {
  const prioritized=prioritizeAreas(rows);
  const tiers=[[],[],[],[]];
  for(const area of prioritized) tiers[populationTier(area)].push(area);
  return tiers.flatMap(cityFirstWithinTier).map(area => ({
    ...area,
    partition_state: area.partition_state || area.state,
    partition_city: area.partition_city || area.city,
    partition_zip: area.partition_zip || area.zip,
  }));
}
