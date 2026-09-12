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
