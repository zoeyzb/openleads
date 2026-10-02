export function reconcileExportMetrics(snapshot={}, {strictRows,callReadyRows}={}){
  const next={...snapshot};
  if(Number.isFinite(Number(strictRows)))next.strictEligible=Math.max(0,Number(strictRows));
  if(Number.isFinite(Number(callReadyRows)))next.callReady=Math.max(0,Number(callReadyRows));
  next.strictConversion=next.callReady>0?next.strictEligible/next.callReady:0;
  return next;
}
