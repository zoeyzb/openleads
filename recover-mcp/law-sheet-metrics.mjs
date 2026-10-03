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
