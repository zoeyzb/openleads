export function normalizePhone(value=''){
  const digits=String(value||'').replace(/\D/g,'');
  return digits.length>=10?digits.slice(-10):digits;
}
export function normalizeText(value=''){
  return String(value||'').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
}
function normalizeAddress(value=''){
  return normalizeText(value)
    .replace(/\broad\b/g,'rd').replace(/\bstreet\b/g,'st').replace(/\bavenue\b/g,'ave')
    .replace(/\bboulevard\b/g,'blvd').replace(/\bdrive\b/g,'dr').replace(/\blane\b/g,'ln')
    .replace(/\bcourt\b/g,'ct').replace(/\bhighway\b/g,'hwy').replace(/\bparkway\b/g,'pkwy')
    .replace(/\s+/g,' ').trim();
}
export function mapIdentityFromUrl(value=''){
  const s=String(value||'');
  try{
    const u=new URL(s);
    const cid=u.searchParams.get('cid'); if(cid) return `cid:${cid}`;
    const place=u.searchParams.get('query_place_id')||u.searchParams.get('place_id'); if(place) return `place:${place}`;
  }catch{}
  const cid=s.match(/[?&]cid=(\d+)/i)?.[1]; if(cid)return `cid:${cid}`;
  const place=s.match(/(?:place_id|query_place_id)=([^&]+)/i)?.[1]; if(place)return `place:${decodeURIComponent(place)}`;
  return '';
}
function addUnique(map,k,row){
  if(!k)return;
  if(!map.has(k)) map.set(k,row);
  else if(map.get(k)!==row) map.set(k,null);
}
export function buildIdentityIndex(rows=[]){
  const byPhone=new Map(),byMap=new Map(),byNameAddress=new Map(),byRawLead=new Map();
  for(const row of rows){
    const lead=row.lead||row; const key=row.key||lead.key||'';
    const rec={key,lead};
    addUnique(byPhone,normalizePhone(lead.phone),rec);
    for(const id of [lead.place_id?`place:${lead.place_id}`:'',lead.cid?`cid:${lead.cid}`:'',mapIdentityFromUrl(lead.google_maps_url||lead.maps_url||'')]) addUnique(byMap,id,rec);
    const na=`${normalizeText(lead.name||lead.title)}|${normalizeAddress(lead.address)}`;
    if(na!=='|')addUnique(byNameAddress,na,rec);
    if(lead.raw_lead_id)addUnique(byRawLead,String(lead.raw_lead_id),rec);
  }
  return {byPhone,byMap,byNameAddress,byRawLead};
}
export function chooseHistoricalMatch(row={},index={},opts={}){
  const rawId=String(row.raw_lead_id||'').trim();
  const rawMap=opts.rawLeadMap||index.byRawLead;
  if(rawId&&rawMap?.has(rawId)){
    const v=rawMap.get(rawId); if(v){
      if(typeof v==='string'){
        const pools=[index.byPhone,index.byMap,index.byNameAddress,index.byRawLead];
        for(const pool of pools){
          for(const rec of pool?.values?.()||[]){
            if(rec&&rec.key===v)return {...rec,method:'raw_lead_id'};
          }
        }
      } else return {...v,method:'raw_lead_id'};
    }
  }
  for(const id of [row.place_id?`place:${row.place_id}`:'',row.cid?`cid:${row.cid}`:'',mapIdentityFromUrl(row.maps_url||row.google_maps_url||'')]){
    if(!id)continue; const v=index.byMap?.get(id); if(v)return {...v,method:'maps'};
  }
  const na=`${normalizeText(row.name||row.title)}|${normalizeAddress(row.address)}`;
  if(na!=='|'){const v=index.byNameAddress?.get(na);if(v)return {...v,method:'name_address'};}
  const phone=normalizePhone(row.phone); if(phone){const v=index.byPhone?.get(phone); if(v)return {...v,method:'phone'};}
  return null;
}
