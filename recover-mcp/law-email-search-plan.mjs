export function buildLawEmailSearchQueries({
  attorneyQueries=[],
  baseQueries=[],
  headcountQueries=[],
  sizeVerified=false,
  phoneReady=false,
  conversionHeadcountPriority=false,
  chicagoWebsiteBuild=false
}={}){
  const emailFirst=Boolean(sizeVerified);
  const sizeFirst=!emailFirst&&(phoneReady||conversionHeadcountPriority||chicagoWebsiteBuild);
  const ordered=emailFirst
    ? [...attorneyQueries,...baseQueries,...headcountQueries]
    : sizeFirst
      ? [...headcountQueries,...attorneyQueries.slice(0,2),...baseQueries,...attorneyQueries.slice(2)]
      : [...attorneyQueries,...baseQueries,...headcountQueries];
  return [...new Set(ordered.filter(Boolean))];
}
