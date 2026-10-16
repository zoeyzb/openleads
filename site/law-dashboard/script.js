const FEED="https://gist.githubusercontent.com/zoeyzb/e7e05d76a0f1855e1953a69ce1b461dc/raw/law-pipeline-metrics.json";
const get=id=>document.getElementById(id);
const fmt=x=>Number.isFinite(x)?new Intl.NumberFormat("en-US").format(x):"—";
function ago(s){const m=Math.max(0,Math.floor((Date.now()-Date.parse(s))/60000));return !Number.isFinite(m)?"unknown":m<2?"just now":m<60?m+"m ago":m<1440?Math.floor(m/60)+"h ago":Math.floor(m/1440)+"d ago"}
let trendMetric="qualified";
document.querySelector("#mobile-menu")?.addEventListener("click",()=>{
 const rail=document.querySelector(".rail"),button=get("mobile-menu");
 rail.classList.toggle("menu-open");
 button.setAttribute("aria-expanded",String(rail.classList.contains("menu-open")));
});
document.querySelectorAll(".rail nav a").forEach(a=>a.addEventListener("click",()=>{
 document.querySelector(".rail").classList.remove("menu-open");get("mobile-menu")?.setAttribute("aria-expanded","false");
}));
for(const button of document.querySelectorAll("[data-metric]"))button.addEventListener("click",()=>{
 trendMetric=button.dataset.metric;
 document.querySelectorAll("[data-metric]").forEach(b=>b.classList.toggle("active",b===button));
 if(lastMetrics)drawTrend(lastMetrics);
});
function drawTrend(d){
 const chart=get("trend-chart");chart.replaceChildren();
 const history=Array.isArray(d.history)?d.history.slice(-30):[];
 get("trend-range").textContent=history.length?history.length+" real hourly samples":"No historical samples yet";
 if(!history.length){chart.textContent="Waiting for the first Mac snapshot";return}
 const values=history.map(v=>Number(v[trendMetric]||0));
 const max=Math.max(1,...values),min=0;
 const width=800,height=170,pad=24;
 const coords=values.map((v,i)=>[pad+(history.length===1?0.5:i/(history.length-1))*(width-pad*2),height-pad-(v-min)/(max-min)*(height-pad*2)]);
 const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");svg.setAttribute("viewBox","0 0 800 170");svg.setAttribute("role","img");svg.setAttribute("aria-label",trendMetric+" measured over "+history.length+" hourly samples");
 for(let i=0;i<4;i++){const l=document.createElementNS(svg.namespaceURI,"line");const y=pad+i*(height-pad*2)/3;for(const [key,val] of Object.entries({x1:pad,x2:width-pad,y1:y,y2:y,stroke:"#e8eee7","stroke-width":"1"}))l.setAttribute(key,String(val));svg.append(l)}
 const poly=document.createElementNS(svg.namespaceURI,"polyline");poly.setAttribute("points",coords.map(p=>p.join(",")).join(" "));poly.setAttribute("fill","none");poly.setAttribute("stroke","#4d8055");poly.setAttribute("stroke-width","3");poly.setAttribute("stroke-linejoin","round");poly.setAttribute("stroke-linecap","round");svg.append(poly);
 for(const [x,y] of coords){const c=document.createElementNS(svg.namespaceURI,"circle");c.setAttribute("cx",x);c.setAttribute("cy",y);c.setAttribute("r","4");c.setAttribute("fill","#4d8055");svg.append(c)}
 chart.append(svg);
 get("trend-latest").textContent="Latest "+trendMetric+": "+fmt(values[values.length-1]);
}
let chartMode="bar",lastMetrics=null;
function drawCharts(d){
 lastMetrics=d;drawTrend(d);
 const sources=d.sourceBreakdown||{};
 const fl=Number(sources["FL roster"]||0),ny=Number(sources["NY registrations"]||0),total=fl+ny;
 const chart=get("source-chart"),legend=get("source-legend");chart.replaceChildren();legend.replaceChildren();
 if(!total){chart.textContent="No source breakdown published yet";return}
 if(chartMode==="donut"){
  const shape=document.createElement("div");shape.className="donut";
  shape.style.background="conic-gradient(#395e46 0 "+(fl/total*100)+"%,#b9dd80 "+(fl/total*100)+"% 100%)";
  const mid=document.createElement("div");mid.className="donut-center";
  const big=document.createElement("strong");big.textContent=fmt(total);
  const sub=document.createElement("small");sub.textContent="research records";mid.append(big,sub);shape.append(mid);chart.append(shape);
 }else{
  const bars=document.createElement("div");bars.className="chart-bars";
  for(const [label,value,klass] of [["FL",fl,"fl"],["NY",ny,"ny"]]){
   const group=document.createElement("div");group.className="bar-group";
   const number=document.createElement("strong");number.className="bar-total";number.textContent=fmt(value);
   const block=document.createElement("span");block.className="bar-fill "+klass;block.style.height=(Math.max(2,value/Math.max(fl,ny)*75))+"%";
   group.append(number,block);bars.append(group);
  }chart.append(bars);
 }
 for(const [label,klass] of [["Florida roster","legend-fl"],["New York registrations","legend-ny"]]){
  const item=document.createElement("span"),dot=document.createElement("i");dot.className="legend-dot "+klass;
  item.append(dot,document.createTextNode(label));legend.append(item);
 }
 const candidates=d.candidateStatuses||{},list=get("queue-bars");list.replaceChildren();
 const entries=[["Pending",Number(candidates.pending||0),"pending"],["Firm size review",Number(candidates.review_headcount_scope||0),"size"],["Non-law employer",Number(candidates.review_nonlaw_employer||0),"reject"]];
 const known=entries.reduce((a,b)=>a+b[1],0),sum=Object.values(candidates).reduce((a,b)=>a+(Number(b)||0),0);
 if(sum>known)entries.push(["Other review",sum-known,"other"]);
 for(const [label,value,klass] of entries){
  const row=document.createElement("div");row.className="queue-item";
  const top=document.createElement("div");top.className="queue-top";
  const title=document.createElement("span");title.textContent=label;
  const num=document.createElement("b");num.textContent=fmt(value);top.append(title,num);
  const track=document.createElement("div");track.className="queue-track";
  const fill=document.createElement("div");fill.className="queue-fill "+klass;fill.style.width=(sum?value/sum*100:0)+"%";
  track.append(fill);row.append(top,track);list.append(row);
 }get("queue-total").textContent=fmt(sum);
}
for(const btn of document.querySelectorAll("[data-view]"))btn.addEventListener("click",()=>{
 chartMode=btn.dataset.view;
 for(const x of document.querySelectorAll("[data-view]"))x.classList.toggle("active",x===btn);
 if(lastMetrics)drawCharts(lastMetrics);
});
function render(d){
 if(d.schema!==1||!Number.isFinite(d.research)||!Number.isFinite(d.callingQualified))throw Error("Invalid feed");
 drawCharts(d);
 const candidates=Object.values(d.candidateStatuses||{}).reduce((a,b)=>a+(Number(b)||0),0);
 const triage=Object.values(d.triageStatuses||{}).reduce((a,b)=>a+(Number(b)||0),0);
 for(const [key,val] of Object.entries({"qualified":d.callingQualified,"stage-qualified":d.callingQualified,"research":d.research,"source-stage":d.research,"candidates":candidates,"unverified":candidates,"triaged":triage}))get(key).textContent=fmt(val);
 get("db-status").textContent="CONNECTED";get("triage-status").textContent=triage?"CHECKPOINTED":"EMPTY";
 const health=String(d.lastVerification?.siteHealth||d.providerHealth||"unknown").toLowerCase();
 get("site-health").textContent=health.toUpperCase();get("site-health").className="check-label "+(health==="usable"?"":"bad");
 get("site-gate").textContent=health==="usable"?"AVAILABLE":"BLOCKED";
 get("published-time").textContent=ago(d.updatedAt);get("feed-stamp").textContent="Mac snapshot · "+new Date(d.updatedAt).toLocaleString();
 get("qualification-note").textContent="Email optional";
 get("blocking-title").textContent=health==="usable"?"Search preflight passed — firm checks still required":"Owned-website verification needs attention";
 get("blocking-description").textContent=health==="usable"?"Each firm still needs direct size, phone, and owned-site evidence.":"Search provider status: "+health+". Firm-wide attorney count also requires independent confirmation.";
 const list=get("coverage-list");list.replaceChildren();const areas=Array.isArray(d.coverage)?d.coverage:[];
 get("areas-count").textContent=areas.length+" AREAS";
 if(!areas.length){const e=document.createElement("div");e.className="empty";e.textContent="No checkpoint data";list.append(e)}
 for(const a of areas){
  const e=document.createElement("div");e.className="area";const h=document.createElement("div");h.className="area-head";
  const code=document.createElement("strong");code.textContent=String(a.state||"").slice(0,3);
  const status=document.createElement("span");status.textContent=a.stateStatus==="checked"?"CHECKED":a.stateStatus==="low-yield"?"LOW YIELD":"UNSTARTED";status.className=a.stateStatus==="checked"?"flag-checked":a.stateStatus==="low-yield"?"flag-low":"flag-not";h.append(code,status);
  const p=document.createElement("p");p.textContent=fmt(Number(a.attempts||0))+" source attempts";
  const small=document.createElement("small");small.textContent=a.lastAttempt?"Last run "+ago(a.lastAttempt):"Never started";e.append(h,p,small);list.append(e);
 }
 const age=(Date.now()-Date.parse(d.updatedAt))/60000;const state=get("connection-state");state.textContent=(age>30?"STALE":"LIVE")+" · "+ago(d.updatedAt);state.className="status-label "+(age>30?"offline":"online");
}
async function refresh(){
 const button=get("refresh");button.disabled=true;button.textContent="↻ Syncing…";
 try{const r=await fetch(FEED+"?v="+Date.now(),{cache:"no-store",signal:AbortSignal.timeout(18000)});if(!r.ok)throw Error("HTTP "+r.status);render(await r.json())}
 catch(e){const s=get("connection-state");s.textContent="FEED UNAVAILABLE";s.className="status-label offline";get("blocking-title").textContent="Mac metrics feed unavailable";get("blocking-description").textContent="Last successful values stay visible. Check the Mac publishing job.";console.error(e)}
 finally{button.disabled=false;button.textContent="↻ Refresh data"}
}
get("refresh").addEventListener("click",refresh);refresh();setInterval(refresh,60000);
function drawCRM(d){const target=get('crm-items');if(!target)return;target.replaceChildren();const q=(get('crm-search')?.value||'').toLowerCase();const data=[...Object.entries(d.sourceBreakdown||{}).map(([name,n])=>({kind:'Source',name,n})),...Object.entries(d.candidateStatuses||{}).map(([name,n])=>({kind:'Queue',name:name.replaceAll('_',' '),n}))].filter(v=>(v.name+' '+v.kind).toLowerCase().includes(q)).sort((a,b)=>b.n-a.n);for(const v of data){const item=document.createElement('div');item.className='crm-item';const label=document.createElement('div');const tag=document.createElement('small');tag.textContent=v.kind;const name=document.createElement('strong');name.textContent=v.name;label.append(tag,name);const number=document.createElement('span');number.textContent=Number(v.n).toLocaleString();item.append(label,number);target.append(item)}if(!data.length)target.textContent='No matching source or queue statuses'}
get('crm-search')?.addEventListener('input',()=>{if(lastMetrics)drawCRM(lastMetrics)});
get('crm-download')?.addEventListener('click',()=>{if(!lastMetrics)return;const rows=[['type','name','count'],...Object.entries(lastMetrics.sourceBreakdown||{}).map(([k,v])=>['source',k,v]),...Object.entries(lastMetrics.candidateStatuses||{}).map(([k,v])=>['queue',k,v])];const csv=rows.map(r=>r.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\n');const url=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));const a=document.createElement('a');a.href=url;a.download='law-research-aggregates.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)});
const previousRender=render;render=function(d){previousRender(d);drawCRM(d)};
