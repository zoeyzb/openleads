export const CALL_READY_WEBSITE_AUDIT_VERSION="call-ready-site-v1";

export function callReadyQualificationState({
  usablePhone=false,
  attorneyCount=0,
  attorneyCountVerified=false,
  website="",
  websiteAuditStatus="",
  websiteAuditVersion=""
}={}, {auditVersion=CALL_READY_WEBSITE_AUDIT_VERSION}={}){
  const hasWebsite=/^https?:\/\//i.test(String(website||"").trim());
  if(hasWebsite)return {callReady:false,needsWebsiteAudit:false,reason:"owned_website"};
  if(!usablePhone)return {callReady:false,needsWebsiteAudit:false,reason:"no_usable_phone"};
  const count=Number(attorneyCount||0);
  if(attorneyCountVerified!==true)return {callReady:false,needsWebsiteAudit:false,reason:"unverified_attorney_count"};
  if(count<2||count>10)return {callReady:false,needsWebsiteAudit:false,reason:"wrong_size"};
  const auditCurrent=String(websiteAuditVersion||"")===String(auditVersion||"");
  if(auditCurrent&&String(websiteAuditStatus||"")==="owned_site"){
    return {callReady:false,needsWebsiteAudit:false,reason:"owned_website"};
  }
  if(auditCurrent&&String(websiteAuditStatus||"")==="no_owned_site"){
    return {callReady:true,needsWebsiteAudit:false,reason:"call_ready"};
  }
  return {callReady:false,needsWebsiteAudit:true,reason:"website_audit_required"};
}

export function headcountRetryDisposition(lead={}, {
  currentMethodVersion="",
  maxAttempts=3
}={}){
  const sameVersion=String(lead.phone_headcount_method_version||"")===String(currentMethodVersion||"");
  const attempt=sameVersion?Math.max(0,Number(lead.phone_headcount_attempts||0)):0;
  const max=Math.max(1,Number(maxAttempts)||3);
  return {
    attempt,
    shouldRetry:attempt<max,
    exhausted:attempt>=max
  };
}

export function shouldRecycleLegacyEmailRecovery({
  lane="general",
  lawEmailValidation="",
  sizeReady=false
}={}){
  return String(lane)==="size_ready" &&
    sizeReady===true &&
    String(lawEmailValidation||"")==="recovery_pending";
}
