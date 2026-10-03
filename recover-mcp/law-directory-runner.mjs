export async function runBoundedDirectoryCandidates(
  items=[],
  worker,
  {concurrency=6,timeoutMs=45000}={}
){
  const values=[...items];
  if(!values.length)return [];
  const limit=Math.max(1,Math.min(values.length,Number(concurrency)||1));
  const deadline=Math.max(100,Number(timeoutMs)||45000);
  const results=new Array(values.length);
  let index=0;

  const run=async()=>{
    while(true){
      const i=index++;
      if(i>=values.length)return;
      const controller=new AbortController();
      let timer;
      try{
        const timeout=new Promise((_,reject)=>{
          timer=setTimeout(()=>{
            controller.abort();
            reject(new Error(`directory candidate timed out after ${deadline}ms`));
          },deadline);
        });
        const value=await Promise.race([
          Promise.resolve().then(()=>worker(values[i],{signal:controller.signal,index:i})),
          timeout
        ]);
        results[i]={status:"fulfilled",value};
      }catch(reason){
        results[i]={status:"rejected",reason};
      }finally{
        if(timer)clearTimeout(timer);
      }
    }
  };

  await Promise.all(Array.from({length:limit},()=>run()));
  return results;
}
