export function needsStrictOwnedWebsiteAudit({
  website="",
  emailSourceVerified=false,
  emails=[],
  attorneyCount=0,
  attorneyCountVerified=false
}={}){
  const hasWebsite=/^https?:\/\//i.test(String(website||"").trim());
  const hasVerifiedEmail=emailSourceVerified===true&&Array.isArray(emails)&&emails.some(Boolean);
  const n=Number(attorneyCount||0);
  const targetSize=attorneyCountVerified===true&&n>=2&&n<=10;
  return !hasWebsite&&hasVerifiedEmail&&targetSize;
}
