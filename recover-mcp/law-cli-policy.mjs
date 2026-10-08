// Pure policy shared by the daemon and portable one-batch CLI.
// No network access or long-running processes in this module.
function bounded(raw,fallback,min,max){
  const value=Number(raw);
  if(raw===undefined||raw===null||raw===""||!Number.isFinite(value))return fallback;
  return Math.max(min,Math.min(max,Math.floor(value)));
}
export function readLawWorkerOptions(argv=[],env={}){
  const allowed=new Set(["--once","--bootstrap","--no-bootstrap","--discover"]);
  for(const arg of argv){
    if(!allowed.has(arg))throw new Error("unknown law worker option: "+arg);
  }
  const args=new Set(argv);
  if(args.has("--bootstrap")&&args.has("--no-bootstrap"))throw new Error("conflicting bootstrap options");
  if(!args.has("--once")&&(args.has("--bootstrap")||args.has("--no-bootstrap")||args.has("--discover")))
    throw new Error("--bootstrap/--discover require --once");
  const once=args.has("--once");
  return Object.freeze({
    mode:once?"once":"daemon",
    bootstrap:once?args.has("--bootstrap"):true,
    discover:once?args.has("--discover"):true,
    batchSize:once?bounded(env.LAW_CLI_BATCH_LIMIT,8,1,32):bounded(env.LAW_FIRM_ENRICH_BATCH,96,1,96),
    concurrency:once?bounded(env.LAW_CLI_CONCURRENCY,4,1,8):bounded(env.LAW_FIRM_ENRICH_CONCURRENCY,32,1,32),
    auditBatchSize:once?bounded(env.LAW_CLI_AUDIT_BATCH,4,1,16):bounded(env.LAW_CALL_READY_AUDIT_BATCH,24,1,48),
    auditConcurrency:once?bounded(env.LAW_CLI_AUDIT_CONCURRENCY,2,1,4):bounded(env.LAW_CALL_READY_AUDIT_CONCURRENCY,6,1,12)
  });
}
export function shouldRequeueLegacyEmail({callingMode=true,legacyRecoveryPending=false}={}){
  return callingMode!==true&&legacyRecoveryPending===true;
}
export function headcountTimeoutDisposition({attempts=0,attemptVersion="",currentVersion="",maxAttempts=2}={}){
  const version=String(currentVersion||"");
  const previous=String(attemptVersion||"")===version?Math.max(0,Number(attempts)||0):0;
  const nextAttempt=Math.min(Math.max(1,Number(maxAttempts)||2),previous+1);
  return {nextAttempt,attemptVersion:version,retry:nextAttempt<Math.max(1,Number(maxAttempts)||2)};
}
