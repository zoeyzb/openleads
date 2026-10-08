export function sourceCircuitState({
  attempts=0,
  hits=0
}={}, {
  minAttempts=250,
  minYield=0.005
}={}){
  const a=Math.max(0,Number(attempts)||0);
  const h=Math.max(0,Number(hits)||0);
  const threshold=Math.max(1,Number(minAttempts)||250);
  const floor=Math.max(0,Number(minYield)||0);
  const yieldRate=a>0?h/a:0;
  if(a<threshold)return {enabled:true,yieldRate,reason:"insufficient_sample"};
  if(yieldRate<floor)return {enabled:false,yieldRate,reason:"low_yield"};
  return {enabled:true,yieldRate,reason:"productive"};
}
