export function geoBiasForJob(job={},coveragePass=1){
  const pass=Math.max(1,Number(coveragePass)||1);
  const lat=Number(job.source_latitude),lon=Number(job.source_longitude);
  const population=Number(job.source_city_population||job.source_population||0);
  if(pass<8||population<10000||!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180) return null;

  let hash=0;
  for(const ch of String((job.partition_state||'')+'|'+(job.partition_city||'')+'|'+(job.partition_zip||job.source_zip||''))) hash=(hash*31+ch.charCodeAt(0))>>>0;

  const ring=Math.max(0,Math.floor((pass-8)/8));
  const cell=(hash+Math.max(0,pass-8))%8;
  const angle=(Math.PI*2*cell)/8;
  const baseDistance=population>=300000?12:population>=100000?9.5:population>=50000?7.5:population>=25000?5.5:3.5;
  const distanceKm=baseDistance*(1+0.9*ring);
  const latOffset=(distanceKm/111)*Math.cos(angle);
  const lonScale=Math.max(0.2,Math.cos(lat*Math.PI/180));
  const lonOffset=(distanceKm/(111*lonScale))*Math.sin(angle);
  const centerLat=Math.max(-89.9,Math.min(89.9,lat+latOffset));
  const centerLon=Math.max(-179.9,Math.min(179.9,lon+lonOffset));
  const zoom=ring>=2?11:population>=300000?12:population>=50000?13:14;
  const radiusKm=Math.min(24,Math.max(8,baseDistance*0.9+5+ring*2));
  return {lat:centerLat,lon:centerLon,zoom,radius:Math.round(radiusKm*1000),cell,ring,distanceKm};
}