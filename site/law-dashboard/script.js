const FEED='https://gist.githubusercontent.com/zoeyzb/e7e05d76a0f1855e1953a69ce1b461dc/raw/law-pipeline-metrics.json';
const $=id=>document.getElementById(id);
const format=n=>Number(n||0).toLocaleString();
let data=null;let period=24;let queueFilter='all';let sourceKind='all';
const tabs=['dashboard','queue','sources','coverage','system'];
function navigate(){const tab=location.hash.slice(1);const active=tabs.includes(tab)?tab:'dashboard';document.querySelectorAll('[data-tab]').forEach(el=>{el.classList.toggle('active',el.dataset.tab===active);el.setAttribute('aria-current',el.dataset.tab===active?'page':'false')});document.querySelectorAll('[data-panel]').forEach(el=>el.hidden=el.dataset.panel!==active);$('view-title').textContent=active.charAt(0).toUpperCase()+active.slice(1);window.scrollTo(0,0)}
window.addEventListener('hashchange',navigate);navigate();
function ago(s){const delta=(Date.now()-Date.parse(s))/60000;if(!Number.isFinite(delta))return 'unknown';return delta<2?'just now':delta<60?Math.floor(delta)+'m ago':delta<1440?Math.floor(delta/60)+'h ago':Math.floor(delta/1440)+'d ago'}
function render(d){if(d.schema!==1||!Number.isFinite(d.research))throw Error('Invalid metrics');data=d;
 const statuses=d.candidateStatuses||{},pending=Object.values(statuses).reduce((a,b)=>a+Number(b||0),0),triaged=Object.values(d.triageStatuses||{}).reduce((a,b)=>a+Number(b||0),0);
 for(const [key,value] of Object.entries({qualified:d.callingQualified,candidates:pending,research:d.research,triaged, 'queue-number':d.callingQualified,'system-qualified':d.callingQualified}))$(key).textContent=format(value);
 const site=String(d.providerHealth||'unknown');if($('site-state'))$('site-state').textContent=site==='usable'?'CHECKS AVAILABLE':'BLOCKED';$('system-site').textContent=site.toUpperCase();
 $('feed-status').textContent='Mac updated '+ago(d.updatedAt);$('system-feed').textContent='Updated '+ago(d.updatedAt);$('updated').textContent=ago(d.updatedAt);$('footer-date').textContent=new Date(d.updatedAt).toLocaleString();
 const breakdown=$('queue-breakdown');breakdown.replaceChildren();const items=[['Pending',statuses.pending||0],['Website review',statuses.review_website||0],['Other review',pending-Number(statuses.pending||0)-Number(statuses.review_website||0)]];
 for(const [name,count] of items){const el=document.createElement('div');el.className='simple-row';const nameEl=document.createElement('strong');nameEl.textContent=name;const countEl=document.createElement('b');countEl.textContent=format(count);el.append(nameEl,countEl);breakdown.append(el)}
 const sources=Object.entries(d.sourceBreakdown||{});$('source-summary').textContent=sources.map(([key,n])=>key+': '+format(n)).join(' · ')||'No source data';paintTable();paintInsights(d);paintQueue(d);
 const cards=$('coverage-cards');cards.replaceChildren();for(const row of d.coverage||[]){const el=document.createElement('div');el.className='state';const title=document.createElement('strong');title.textContent=row.state;const status=document.createElement('span');status.className='status';status.textContent=row.stateStatus==='checked'?'CHECKED':row.stateStatus==='low-yield'?'LOW YIELD':'NOT STARTED';const attempts=document.createElement('p');attempts.textContent=format(row.attempts)+' source attempts';const date=document.createElement('small');date.textContent=row.lastAttempt?'Last checked '+ago(row.lastAttempt):'Not yet checked';el.append(status,title,attempts,date);cards.append(el)}
}
function rows(){return data?[...Object.entries(data.sourceBreakdown||{}).map(([name,count])=>['Source',name,count]),...Object.entries(data.candidateStatuses||{}).map(([name,count])=>['Review',name.replaceAll('_',' '),count])]:[]}
function paintTable(){const tbody=$('source-table');tbody.replaceChildren();const query=$('search').value.toLowerCase();for(const r of rows().filter(r=>(sourceKind==='all'||r[0]===sourceKind)&&r.join(' ').toLowerCase().includes(query))){const tr=document.createElement('tr');r.forEach((v,i)=>{const td=document.createElement('td');td.textContent=i===2?format(v):v;if(i===2)td.className='number';tr.append(td)});tbody.append(tr)}if(!tbody.children.length){const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=3;td.textContent='No matching records';tr.append(td);tbody.append(tr)}}
$('search').addEventListener('input',paintTable);
$('export').addEventListener('click',()=>{if(!data)return;const csv=[['Category','Source or stage','Records'],...rows()].map(r=>r.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\n');const link=document.createElement('a');const url=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));link.href=url;link.download='openleads-source-aggregates.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1500)});
async function refresh(){const b=$('refresh');b.disabled=true;try{const res=await fetch(FEED+'?t='+Date.now(),{cache:'no-store',signal:AbortSignal.timeout(18000)});if(!res.ok)throw Error('feed '+res.status);render(await res.json())}catch(err){$('feed-status').textContent='Feed unavailable';$('system-feed').textContent='Last update unavailable';console.error(err)}finally{b.disabled=false}}
$('refresh').addEventListener('click',refresh);refresh();setInterval(refresh,60000);

function paintQueue(d){
 const target=$('queue-status-list');if(!target)return;target.replaceChildren();
 const statuses=Object.entries(d.candidateStatuses||{}).filter(([name])=>queueFilter==='all'||(queueFilter==='pending'?name==='pending':name!=='pending'));
 statuses.sort((a,b)=>b[1]-a[1]);
 for(const [name,count] of statuses){const row=document.createElement('div');row.className='review-row';const label=document.createElement('strong');label.textContent=name.replaceAll('_',' ');const value=document.createElement('b');value.textContent=format(count);row.append(label,value);target.append(row)}
 if(!statuses.length)target.textContent='No matching review statuses';
}
document.querySelectorAll('[data-queuefilter]').forEach(btn=>btn.addEventListener('click',()=>{queueFilter=btn.dataset.queuefilter;document.querySelectorAll('[data-queuefilter]').forEach(x=>x.classList.toggle('active',x===btn));if(data)paintQueue(data)}));
document.querySelectorAll('[data-kind]').forEach(btn=>btn.addEventListener('click',()=>{sourceKind=btn.dataset.kind;document.querySelectorAll('[data-kind]').forEach(x=>x.classList.toggle('active',x===btn));paintTable()}));
document.querySelectorAll('[data-period]').forEach(btn=>btn.addEventListener('click',()=>{period=Number(btn.dataset.period);document.querySelectorAll('[data-period]').forEach(x=>x.classList.toggle('active',x===btn));if(data)paintInsights(data)}));
function paintInsights(d){
 const chart=$('activity-chart'),summary=$('activity-summary');chart.replaceChildren();
 const history=Array.isArray(d.history)?d.history.slice(-period):[];
 if(!history.length){chart.textContent='Awaiting recorded hourly history';summary.textContent='No historical measurements yet.'}
 else {
  const values=history.map(x=>Number(x.triaged||0));const max=Math.max(1,...values),min=Math.min(...values);
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 600 130');svg.setAttribute('role','img');svg.setAttribute('aria-label','Recorded source triage values over time');
  for(let i=0;i<4;i++){const line=document.createElementNS(svg.namespaceURI,'line');const y=18+i*30;for(const [k,v] of Object.entries({x1:12,x2:588,y1:y,y2:y,stroke:'#29292d'}))line.setAttribute(k,v);svg.append(line)}
  const coords=values.map((v,i)=>[16+(values.length===1?.5:i/(values.length-1))*568,108-(v-min)/(Math.max(1,max-min))*82]);
  const path=document.createElementNS(svg.namespaceURI,'polyline');path.setAttribute('points',coords.map(x=>x.join(',')).join(' '));path.setAttribute('fill','none');path.setAttribute('stroke','#f34c59');path.setAttribute('stroke-width','3');path.setAttribute('stroke-linejoin','round');svg.append(path);chart.append(svg);
  summary.textContent=history.length+' real measurements · latest triaged: '+format(values.at(-1));
 }
 const list=$('status-mix');list.replaceChildren();const statuses=Object.entries(d.candidateStatuses||{}).sort((a,b)=>b[1]-a[1]);const total=statuses.reduce((a,b)=>a+Number(b[1]),0);
 for(const [key,value] of statuses){const row=document.createElement('div');row.className='mix-row';const label=document.createElement('div');const title=document.createElement('span');title.textContent=key.replaceAll('_',' ');const count=document.createElement('b');count.textContent=format(value);label.append(title,count);const track=document.createElement('div');track.className='mix-track';const fill=document.createElement('div');fill.style.width=(total?value/total*100:0)+'%';track.append(fill);row.append(label,track);list.append(row)}
}
let localCandidates=[],candidatePage=0;
function visibleCandidates(){
 const term=($('candidate-search')?.value||'').toLowerCase();
 return localCandidates.filter(x=>[x.firm,x.city,x.state,x.status].join(' ').toLowerCase().includes(term));
}
function showEvidence(row){
 const area=$('candidate-detail');area.hidden=false;area.replaceChildren();
 const h=document.createElement('h3');h.textContent=row.firm;
 const p=document.createElement('p');p.textContent=[row.city,row.state,row.phone,row.status].filter(Boolean).join(' · ');
 const warning=document.createElement('p');warning.textContent='Candidate only. Verify total attorneys, no owned website and business phone independently before calling.';
 const src=document.createElement('a');src.href=row.source_url;src.target='_blank';src.rel='noopener noreferrer';src.textContent='Published source ↗';
 const code=document.createElement('pre');code.textContent=JSON.stringify(row.evidence||{},null,2);
 area.append(h,p,warning,src,code);
 area.scrollIntoView({block:'nearest',behavior:'smooth'});
}
function renderCandidates(){
 const body=$('candidate-rows');body.replaceChildren();
 const matches=visibleCandidates();const pages=Math.max(1,Math.ceil(matches.length/12));candidatePage=Math.max(0,Math.min(candidatePage,pages-1));
 for(const record of matches.slice(candidatePage*12,candidatePage*12+12)){
  const tr=document.createElement('tr');
  for(const value of [record.firm,[record.city,record.state].filter(Boolean).join(', '),record.status.replaceAll('_',' ')]){
   const td=document.createElement('td');td.textContent=value;tr.append(td);
  }
  const td=document.createElement('td'),b=document.createElement('button');b.className='evidence-button';b.textContent='View evidence';b.addEventListener('click',()=>showEvidence(record));td.append(b);tr.append(td);body.append(tr);
 }
 if(!matches.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=4;td.textContent='No matching local candidates';tr.append(td);body.append(tr)}
 $('candidate-page-summary').textContent=matches.length+' candidates · '+(candidatePage+1)+' / '+pages;
 $('candidate-prev').disabled=candidatePage===0;$('candidate-next').disabled=candidatePage>=pages-1;
}
async function loadCandidates(){
 if(!['localhost','127.0.0.1'].includes(location.hostname))return;
 try{const response=await fetch('./local-queue.json',{cache:'no-store'});if(!response.ok)throw Error('Missing local snapshot');const payload=await response.json();localCandidates=payload.entries||[];renderCandidates()}
 catch(e){$('candidate-rows').textContent='Local candidate snapshot unavailable. Run python3 ops/local_law/export_local_crm.py on your Mac.'}
}
$('candidate-search').addEventListener('input',()=>{candidatePage=0;renderCandidates()});
$('candidate-prev').addEventListener('click',()=>{candidatePage--;renderCandidates()});
$('candidate-next').addEventListener('click',()=>{candidatePage++;renderCandidates()});
loadCandidates();
