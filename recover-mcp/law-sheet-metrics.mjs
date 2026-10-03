export function reconcileExportMetrics(snapshot={}, {strictRows,callReadyRows}={}){
  const next={...snapshot};
  if(Number.isFinite(Number(strictRows)))next.strictEligible=Math.max(0,Number(strictRows));
  if(Number.isFinite(Number(callReadyRows)))next.callReady=Math.max(0,Number(callReadyRows));

  // Operational funnel: callReady is the 2-10/no-site/callable target cohort.
  // strictEligible is the send-ready subset with source-verified usable email.
  next.callReadyTarget=Math.max(0,Number(next.callReady)||0);
  next.eligible=Math.max(0,Number(next.strictEligible)||0);
  next.emailReady=next.eligible;
  next.emailReadyRate=next.callReadyTarget>0?next.emailReady/next.callReadyTarget:0;

  // Backward-compatible metric name for existing consumers.
  next.strictConversion=next.emailReadyRate;
  return next;
}
