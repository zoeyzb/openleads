"""Recover exact source-published contact evidence from the existing catalog."""
import hashlib,json,sqlite3
from pathlib import Path
from urllib.parse import urlparse
from law_local.worker import norm,normalize_phone,utc_now

def recover(lead,result,catalog,fetch,mx,search,probe=None):
 if result.get("status")!="call_qualified_no_email":return result
 from law_local.worker import SqliteQueue,classify_search_results
 if not SqliteQueue._verified_for_export(lead,result,"call_qualified_no_email"):return result
 from ops.local_law.promote_source_verified import exact_contact_block
 if not Path(catalog).is_file():return result
 try:
  with sqlite3.connect("file:"+str(catalog)+"?mode=ro",uri=True,timeout=3) as con:
   rows=con.execute("SELECT firm,research_json FROM plea_firm_research WHERE phone=?",(normalize_phone(lead["phone"]),)).fetchall()
 except sqlite3.Error:return result
 for firm,raw in rows:
  if norm(firm)!=norm(lead["firm"]):continue
  try:data=json.loads(raw)
  except (ValueError,TypeError):continue
  for member in data.get("members",[])[:2]:
   source=member.get("source_url","");email=member.get("email","").lower()
   host=(urlparse(source).hostname or "").lower()
   if host not in ("plea.net","www.plea.net") or not source.startswith("https://"):continue
   try:
    page=fetch(source,timeout=8)
    block=exact_contact_block(page,lead["firm"],lead["phone"],email,source)
    if not block or not mx(email.rsplit("@",1)[-1]):continue
    from law_local.worker import email_domain_websites
    live_sites=(probe or email_domain_websites)([email])
    if live_sites:
     return {**result,"status":"review_website","site_status":"review_website",
             "site_evidence":{"status":"review_website","reason":"live_published_email_domain","urls":live_sites},
             "email_recovery_source":source}
    providers=search({**lead,"emails":[email]})
    site=classify_search_results(providers)
    if site["status"]!="screened_no_site":
     # A new positive domain overrides prior negative website screening.
     if site["status"]=="review_website":
      return {**result,"status":"review_website","site_status":"review_website",
              "site_evidence":site,"email_recovery_source":source}
     continue
    return {**result,"status":"strict_eligible","qualification_scope":"law_no_owned_website_email",
      "email":email,"email_source":source,"email_mx_ok":True,
      "email_evidence":{"matched_firm":firm,"matched_phone":normalize_phone(lead["phone"]),
         "source_url":source,"block_sha256":hashlib.sha256(block.encode()).hexdigest(),"checked_at":utc_now()},
      "site_evidence":{"providers":providers,"checked_at":utc_now()},"checked_at":utc_now()}
   except (ValueError,TypeError,KeyError,OSError):continue
 return result
