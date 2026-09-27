import { createClient } from 'redis';
import { mergeLeadRecords } from './acquisition-persistence.mjs';
import { buildIdentityIndex, chooseHistoricalMatch } from './historical-email-match.mjs';

const REDIS_URL=process.env.ACQUISITION_REDIS_URL||'';
const SUPABASE_URL=(process.env.SUPABASE_HISTORICAL_URL||'').replace(/\/$/,'');
const SUPABASE_KEY=process.env.SUPABASE_HISTORICAL_ANON_KEY||'';
const INTERVAL_MS=Math.max(60*60*1000,Number(process.env.HISTORICAL_EMAIL_BACKFILL_INTERVAL_MS||6*60*60*1000));
const LEADER='recover:historical-email-backfill:leader:v3';
const STATS='recover:historical-email-backfill:stats:v1';
if(!REDIS_URL) throw new Error('ACQUISITION_REDIS_URL required');
if(!SUPABASE_URL||!SUPABASE_KEY) throw new Error('Supabase historical backfill config required');

const redis=createClient({url:REDIS_URL});
redis.on('error',e=>console.error('historical-email-backfill redis error',e));
await redis.connect();
const INSTANCE=process.env.RAILWAY_REPLICA_ID||process.env.HOSTNAME||Math.random().toString(36).slice(2);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function acquireLeader(){
  return (await redis.set(LEADER,INSTANCE,{NX:true,EX:45}))==='OK';
}
async function renewLeader(){
  if(await redis.get(LEADER)!==INSTANCE)return false;
  await redis.expire(LEADER,45);return true;
}

function validEmails(value){
  const vals=Array.isArray(value)?value:String(value||'').split(/[;,\s]+/);
  return [...new Set(vals.map(x=>String(x||'').trim().toLowerCase()).filter(x=>/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))];
}

async function fetchHistoricalRows(){
  const out=[]; const limit=1000;
  for(let offset=0;offset<100000;offset+=limit){
    const params=new URLSearchParams({
      select:'row_num,id,raw_lead_id,name,niche,address,city,region,phone,email,maps_url,updated_at',
      email:'not.is.null',
      order:'id.asc',
      limit:String(limit),
      offset:String(offset),
    });
    const r=await fetch(`${SUPABASE_URL}/rest/v1/sheet_acquisition_ranked_snapshot?${params}`,{
      headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${SUPABASE_KEY}`,Accept:'application/json'},
      signal:AbortSignal.timeout(60000),
    });
    const text=await r.text();
    if(!r.ok) throw new Error(`supabase_historical_${r.status}: ${text.slice(0,300)}`);
    const rows=JSON.parse(text);
    out.push(...rows);
    if(rows.length<limit)break;
  }
  return out;
}

async function loadLiveRows(){
  const rows=[];
  for await(const page of redis.hScanIterator('recover:leadstore:qualified',{COUNT:500})){
    for(const entry of (Array.isArray(page)?page:[page])){
      if(!entry?.field||entry.value===undefined)continue;
      try{rows.push({key:entry.field,lead:JSON.parse(entry.value)||{}});}catch{}
    }
  }
  return rows;
}

async function runOnce(){
  const started=Date.now();
  const live=await loadLiveRows();
  const index=buildIdentityIndex(live);
  const history=await fetchHistoricalRows();
  const stats={
    historical_rows:history.length,
    historical_with_valid_email:0,
    live_rows:live.length,
    matched:0,matched_raw_lead_id:0,matched_phone:0,matched_maps:0,matched_name_address:0,
    already_had_email:0,updated_leads:0,emails_added:0,unmatched:0,invalid_email:0,
  };
  for(const row of history){
    const emails=validEmails(row.email);
    if(!emails.length){stats.invalid_email++;continue;}
    stats.historical_with_valid_email++;
    const match=chooseHistoricalMatch(row,index);
    if(!match){stats.unmatched++;continue;}
    stats.matched++; stats['matched_'+match.method]=(stats['matched_'+match.method]||0)+1;
    const currentRaw=await redis.hGet('recover:leadstore:qualified',match.key);
    if(!currentRaw){stats.unmatched++;continue;}
    let current;try{current=JSON.parse(currentRaw)||{};}catch{stats.unmatched++;continue;}
    const before=validEmails([...(Array.isArray(current.emails)?current.emails:[]),current.email||'']);
    const merged=mergeLeadRecords(current,{
      emails,
      historical_email_source:'supabase_sheet_acquisition_ranked_snapshot',
      historical_email_source_id:row.id||'',
      historical_email_recovered_at:new Date().toISOString(),
      historical_email_match_method:match.method,
    });
    const after=validEmails([...(Array.isArray(merged.emails)?merged.emails:[]),merged.email||'']);
    const added=after.filter(x=>!before.includes(x));
    if(!added.length){stats.already_had_email++;continue;}
    await redis.hSet('recover:leadstore:qualified',match.key,JSON.stringify(merged));
    stats.updated_leads++;stats.emails_added+=added.length;
    match.lead=merged;
  }
  stats.duration_ms=Date.now()-started;
  await redis.hSet(STATS,Object.fromEntries(Object.entries(stats).map(([k,v])=>[k,String(v)])));
  await redis.hSet(STATS,'completed_at',new Date().toISOString());
  console.log(JSON.stringify({event:'historical_email_backfill_complete',...stats}));
  return stats;
}

while(true){
  try{
    if(await acquireLeader()){
      const timer=setInterval(()=>renewLeader().catch(()=>{}),15000);timer.unref?.();
      await runOnce();
      clearInterval(timer);
      if(await redis.get(LEADER)===INSTANCE)await redis.del(LEADER);
      await sleep(INTERVAL_MS);
    } else {
      console.log(JSON.stringify({event:'historical_email_backfill_standby'}));
      await sleep(30000);
    }
  }catch(error){
    console.error(JSON.stringify({event:'historical_email_backfill_error',error:String(error?.message||error)}));
    await sleep(60000);
  }
}
