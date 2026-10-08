export function shouldThrottleGeneralForSizeReady(backlog=0,{threshold=8}={}){
  const n=Math.max(0,Number(backlog)||0);
  const t=Math.max(1,Number(threshold)||8);
  return n>=t;
}

export function sizeReadyFailureDisposition(currentAttempt=0,{maxAttempts=4}={}){
  const current=Math.max(0,Number(currentAttempt)||0);
  const max=Math.max(1,Number(maxAttempts)||4);
  const next=Math.min(max,current+1);
  return {
    nextAttempt:next,
    shouldRetry:next<max,
    exhausted:next>=max
  };
}


export function shouldScheduleLegacyRecoverable({callingMode=true}={}){
  return callingMode!==true;
}

export function shouldRunEmailConversionWorker({callingMode=true}={}){
  return callingMode!==true;
}

export function shouldCircuitBreakSource({
  attempts=0,
  hits=0,
  adapterVersion="",
  currentVersion="",
  minAttempts=1000,
  minYield=0.01
}={}){
  if(String(adapterVersion||"")!==String(currentVersion||""))return false;
  const a=Math.max(0,Number(attempts)||0);
  const h=Math.max(0,Number(hits)||0);
  const sample=Math.max(1,Number(minAttempts)||1000);
  const floor=Math.max(0,Number(minYield)||0);
  if(a<sample)return false;
  return h/Math.max(1,a)<floor;
}
