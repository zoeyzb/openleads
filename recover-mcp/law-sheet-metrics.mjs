export function reconcileExportMetrics(snapshot={}, {strictRows,callReadyRows}={}){
  const next={...snapshot};
  if(Number.isFinite(Number(strictRows)))next.strictEligible=Math.max(0,Number(strictRows));
  if(Number.isFinite(Number(callReadyRows)))next.callReady=Math.max(0,Number(callReadyRows));

  // Campaign contract: eligible = callable + no owned website + verified 2-10.
  // strictEligible remains the email-ready bonus subset.
  next.callReadyTarget=Math.max(0,Number(next.callReady)||0);
  next.eligible=next.callReadyTarget;
  next.emailReady=Math.max(0,Number(next.strictEligible)||0);
  next.emailReadyRate=next.eligible>0?next.emailReady/next.eligible:0;

  // Backward-compatible metric name for existing consumers.
  next.strictConversion=next.emailReadyRate;
  return next;
}


export function dedupeCallReadyRowsByPhone(rows=[]){
  const out=[];
  const seen=new Set();
  for(const row of Array.isArray(rows)?rows:[]){
    const phone=String(row?.identity||row?.row?.[0]||"").replace(/\D+/g,"").replace(/^1(?=\d{10}$)/,"");
    if(!phone||seen.has(phone))continue;
    seen.add(phone);
    out.push(row);
  }
  return out;
}
