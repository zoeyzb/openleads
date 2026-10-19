export function needsStrictOwnedWebsiteAudit({
  website="",
  emailSourceVerified=false,
  emails=[],
  attorneyCount=0,
  attorneyCountVerified=false
}={}){
  const hasWebsite=/^https?:\/\//i.test(String(website||"").trim());
  const hasVerifiedEmail=emailSourceVerified===true&&Array.isArray(emails)&&emails.some(Boolean);
  return !hasWebsite&&hasVerifiedEmail;
}


export function needsCallReadyOwnedWebsiteAudit({
  website="",
  phone="",
  attorneyCount=0,
  attorneyCountVerified=false,
  noOwnedWebsiteVerified=false
}={}){
  const hasWebsite=/^https?:\/\//i.test(String(website||"").trim());
  const digits=String(phone||"").replace(/\D+/g,"").replace(/^1(?=\d{10}$)/,"");
  const usablePhone=/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)&&!(/^(\d)\1{9}$/.test(digits));
  return !hasWebsite&&usablePhone&&noOwnedWebsiteVerified!==true;
}

// Distinguish a completed negative site audit from a failed or skipped check.
// An outage is neither proof of an owned website nor proof of no website.
export function noOwnedWebsiteAuditOutcome({
  ownedWebsite="",
  checksSucceeded=0,
  checksFailed=0
}={}){
  if(/^https?:\/\//i.test(String(ownedWebsite||"").trim()))return "owned_site";
  if(Number(checksFailed)>0||Number(checksSucceeded)<1)return "inconclusive";
  return "no_site_audited";
}

export function hasCompletedSiteSearch(results=[]){
  return Array.isArray(results)&&results.some(result=>result?.status==="fulfilled"&&result.value?.responded===true);
}
