const FEED="https://gist.githubusercontent.com/zoeyzb/e7e05d76a0f1855e1953a69ce1b461dc/raw/law-pipeline-metrics.json";
const get=id=>document.getElementById(id);
const fmt=x=>Number.isFinite(x)?new Intl.NumberFormat("en-US").format(x):"—";
function ago(s){const m=Math.max(0,Math.floor((Date.now()-Date.parse(s))/60000));return !Number.isFinite(m)?"unknown":m<2?"just now":m<60?m+"m ago":m<1440?Math.floor(m/60)+"h ago":Math.floor(m/1440)+"d ago"}
function render(d){
 if(d.schema!==1||!Number.isFinite(d.research)||!Number.isFinite(d.callingQualified))throw Error("Invalid feed");
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
