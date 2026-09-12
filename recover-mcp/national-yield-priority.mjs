const PRIOR={hvac:7,plumbing:6,furnace:5,boiler:4,refrigeration:3,duct:2,ventilation:1};

export function buildYieldStats(jobs=[]){
  const stats={};
  for(const job of jobs){
    const key=String(job?.service_family||'').trim();
    if(!key) continue;
    const terminal=['partial_complete','complete','completed','failed'].includes(String(job?.status||job?.phase||'')) || Number(job?.rounds_completed||0)>0;
    if(!terminal) continue;
    const s=stats[key]||(stats[key]={attempts:0,stored:0,positive:0,zero:0});
    const stored=Math.max(0,Number(job?.stored_count||0));
    s.attempts++; s.stored+=stored;
    if(stored>0) s.positive++; else s.zero++;
  }
  return stats;
}

export function familyYieldScore(key,stats={}){
  const s=stats[key]||{attempts:0,stored:0,positive:0};
  const prior=PRIOR[key]||0;
  if(s.attempts<8) return prior;
  const avg=s.stored/s.attempts;
  const positive=s.positive/s.attempts;
  return avg*10+positive*4+prior*0.05;
}

export function rankFamilies(families,stats={}){
  return [...families].sort((a,b)=>familyYieldScore(b,stats)-familyYieldScore(a,stats));
}

export function weightedFamilySchedule(ranked=[],size=48){
  if(!ranked.length) return [];
  const weights=ranked.map((_,i)=>Math.max(1,ranked.length-i));
  const schedule=[];
  let i=0;
  while(schedule.length<size){
    const idx=i%ranked.length;
    for(let n=0;n<weights[idx]&&schedule.length<size;n++) schedule.push(ranked[idx]);
    i++;
  }
  return schedule;
}

export function prioritizeAreas(rows=[]){
  const tiers=[[],[],[],[]];
  for(const row of rows){
    const p=Number(row?.population||0);
    const tier=p>=25000?0:p>=10000?1:p>=2500?2:3;
    tiers[tier].push(row);
  }
  const out=[];
  for(const tierRows of tiers){
    const states=new Map();
    for(const row of tierRows){
      if(!states.has(row.state)) states.set(row.state,[]);
      states.get(row.state).push(row);
    }
    const queues=[...states.entries()].map(([state,items])=>({state,items:items.sort((a,b)=>Number(b.population||0)-Number(a.population||0)||String(a.zip).localeCompare(String(b.zip))),cursor:0}));
    queues.sort((a,b)=>Number(b.items[0]?.population||0)-Number(a.items[0]?.population||0)||a.state.localeCompare(b.state));
    for(;;){
      let added=0;
      for(const q of queues){ if(q.cursor<q.items.length){out.push(q.items[q.cursor++]);added++;} }
      if(!added) break;
    }
  }
  return out;
}

export function buildCoverageYieldSchedule(coverageFamilies=[],rankedFamilies=[],size=48,coverageShare=0.7){
  const total=Math.max(0,Math.floor(Number(size)||0));
  if(!total) return [];
  const coverage=[...coverageFamilies];
  const ranked=[...rankedFamilies];
  if(!coverage.length && !ranked.length) return [];
  const share=Math.min(1,Math.max(0,Number(coverageShare)||0));
  const coverageSlots=coverage.length?Math.min(total,Math.max(1,Math.ceil(total*share))):0;
  const yieldSlots=total-coverageSlots;
  const weighted=ranked.length?weightedFamilySchedule(ranked,Math.max(1,yieldSlots)):[];
  const out=[];
  let coverageUsed=0,yieldUsed=0;
  for(let i=0;i<total;i++){
    const targetCoverage=Math.min(coverageSlots,Math.ceil((i+1)*share));
    const useCoverage=coverageUsed<coverageSlots && (yieldUsed>=yieldSlots || coverageUsed<targetCoverage);
    if(useCoverage){
      out.push({mode:'coverage',family:coverage[coverageUsed%coverage.length]});
      coverageUsed++;
    }else if(ranked.length && yieldUsed<yieldSlots){
      out.push({mode:'yield',family:weighted[yieldUsed%weighted.length]});
      yieldUsed++;
    }else{
      out.push({mode:'coverage',family:coverage[coverageUsed%coverage.length]});
      coverageUsed++;
    }
  }
  return out;
}

export function buildCityFirstCoverageAreas(rows=[]){
  const states=new Map();
  for(const row of rows){
    const state=String(row?.state||'').trim();
    const city=String(row?.city||'').trim().toLowerCase();
    if(!state||!city) continue;
    if(!states.has(state)) states.set(state,new Map());
    const cities=states.get(state);
    if(!cities.has(city)) cities.set(city,[]);
    cities.get(city).push(row);
  }
  const stateQueues=[...states.entries()].map(([state,cities])=>{
    const groups=[...cities.entries()].map(([city,items])=>({city,items:[...items].sort((a,b)=>Number(b.population||0)-Number(a.population||0)||String(a.zip).localeCompare(String(b.zip)))}));
    groups.sort((a,b)=>Number(b.items[0]?.population||0)-Number(a.items[0]?.population||0)||a.city.localeCompare(b.city));
    return {state,groups,cursor:0};
  }).sort((a,b)=>a.state.localeCompare(b.state));
  const primary=[];
  for(;;){
    let added=0;
    for(const q of stateQueues){
      if(q.cursor<q.groups.length){ primary.push(q.groups[q.cursor++].items[0]); added++; }
    }
    if(!added) break;
  }
  const primaryKeys=new Set(primary.map(x=>`${x.state}|${String(x.city).toLowerCase()}|${x.zip}`));
  const remaining=prioritizeAreas(rows.filter(x=>!primaryKeys.has(`${x.state}|${String(x.city).toLowerCase()}|${x.zip}`)));
  return [...primary,...remaining];
}
