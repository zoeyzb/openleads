function norm(value) {
  return String(value||"").toLowerCase().trim().replace(/\s+/g," ").replace(/[^a-z0-9, .-]+/g,"");
}
export function qualificationProfile(job={}) {
  return [
    `nw:${job.require_no_website?1:0}`,
    `contact:${job.require_contact?1:0}`,
    `phone:${job.require_phone?1:0}`,
    `email:${job.require_email?1:0}`,
    `includeNW:${job.include_no_website===false?0:1}`,
    `score:${Number(job.min_score||0)}`
  ].join("|");
}
export function campaignScope(job={}) {
  const industry=norm(job.industry).replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"")||"unknown";
  const profile=qualificationProfile(job).toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"");
  return `${industry}::${profile}`;
}
export function campaignLeadSetKey(job={}) {
  return `recover:leadstore:scope:${campaignScope(job)}`;
}
export function coverageField(job={}) {
  const base=[norm(job.industry), norm(job.location), qualificationProfile(job)].join("::");
  const pass=norm(job.coverage_pass||"");
  return pass ? `${base}::pass:${pass}` : base;
}
export async function readCoverage(redis, job) {
  const raw=await redis.hGet("recover:coverage:v1", coverageField(job));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return {status:"unknown",raw}; }
}
export async function claimCoverage(redis, job, extra={}) {
  const field=coverageField(job);
  const value=JSON.stringify({
    status:"scheduled",
    industry:job.industry||"",
    location:job.location||"",
    profile:qualificationProfile(job),
    acquisition_id:job.id||null,
    batch_id:job.batch_id||null,
    claimed_at:new Date().toISOString(),
    ...extra
  });
  const claimed=await redis.hSetNX("recover:coverage:v1",field,value);
  return {claimed:Boolean(claimed),field,existing:claimed?null:await readCoverage(redis,job)};
}
export async function markCoverage(redis, job, status, extra={}) {
  const field=coverageField(job);
  const value={
    status,
    industry:job.industry||"",
    location:job.location||"",
    profile:qualificationProfile(job),
    acquisition_id:job.id||null,
    batch_id:job.batch_id||null,
    stored_count:Number(job.stored_count||0),
    qualified_count:Number(job.qualified_count||0),
    unique_count:Number(job.unique_count||0),
    rounds_completed:Number(job.rounds_completed||0),
    completed_at:job.completed_at||new Date().toISOString(),
    updated_at:new Date().toISOString(),
    ...extra
  };
  await redis.hSet("recover:coverage:v1",field,JSON.stringify(value));
  return {field,value};
}
export function coverageBlocksReseed(entry) {
  return ["scheduled","running","target_reached","exhausted"].includes(String(entry?.status||""));
}
