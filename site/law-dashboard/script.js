const FEED="https://gist.githubusercontent.com/zoeyzb/e7e05d76a0f1855e1953a69ce1b461dc/raw/law-pipeline-metrics.json";
const get=id=>document.getElementById(id);
const fmt=x=>Number.isFinite(x)?new Intl.NumberFormat("en-US").format(x):"—";
function ago(s){const m=Math.max(0,Math.floor((Date.now()-Date.parse(s))/60000));return !Number.isFinite(m)?"unknown":m<2?"just now":m<60?m+"m ago":m<1440?Math.floor(m/60)+"h ago":Math.floor(m/1440)+"d ago"}
let chartMode="bar",lastMetrics=null;
function drawCharts(d){
 lastMetrics=d;
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
 const health=String(d.providerHealth||"unknown").toLowerCase();
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
