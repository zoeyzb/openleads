export function needsStrictOwnedWebsiteAudit({
  website="",
  emailSourceVerified=false,
  emails=[],
  attorneyCount=0,
  attorneyCountVerified=false
}={}){
  const hasWebsite=/^https?:\/\//i.test(String(website||"").trim());
  const n=Number(attorneyCount||0);
  const targetSize=attorneyCountVerified===true&&n>=2&&n<=10;
  // Calling is the primary campaign. Once a firm has a usable phone and
  // verified target-size evidence, the owned-site audit is mandatory whether
  // or not an email was found. Email remains bonus evidence only.
  return !hasWebsite&&targetSize;
}
