export function buildTargetHeadcountQueries({
  name="",phone="",city="",state=""
}={}){
  const firm=String(name||"").replace(/"/g,"").trim();
  const digits=String(phone||"").replace(/\D/g,"").slice(-10);
  const pretty=digits.length===10?`${digits.slice(0,3)}-${digits.slice(3,6)}-${digits.slice(6)}`:"";
  const where=[String(city||"").trim(),String(state||"").trim()].filter(Boolean).join(" ");
  return [...new Set([
    ...(pretty?[
      `site:martindale.com/organization "${pretty}" "Firm Size"`,
      `site:lawyer.com "${pretty}" "Firm Size"`,
      `site:lawyers.com "${pretty}" "Law Firm with"`
    ]:[]),
    ...(firm?[
      `site:martindale.com/organization "${firm}" ${where} "Firm Size"`.trim(),
      `site:lawyer.com/firm "${firm}" ${where} "Firm Size"`.trim(),
      `site:lawyers.com "${firm}" ${where} "Law Firm with"`.trim()
    ]:[])
  ].filter(Boolean))].slice(0,6);
}
