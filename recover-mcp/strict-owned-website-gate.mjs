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
  const n=Number(attorneyCount||0);
  const targetSize=attorneyCountVerified===true&&n>=2&&n<=10;
  return !hasWebsite&&usablePhone&&targetSize&&noOwnedWebsiteVerified!==true;
}
