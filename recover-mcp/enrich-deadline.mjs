export async function withOperationDeadline(promise, timeoutMs, label="operation"){
  let timer;
  const timeout=new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error(label+" timed out after "+timeoutMs+"ms")),timeoutMs);
  });
  try{return await Promise.race([promise,timeout]);}
  finally{if(timer)clearTimeout(timer);}
}
