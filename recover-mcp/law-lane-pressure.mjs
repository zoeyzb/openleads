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
