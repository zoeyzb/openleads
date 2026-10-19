"""Public FL Bar Monitor profiles: exact contact and fresh practice-status proof.

Only published attorney profiles are supported. No API, search, auth or redirect
endpoints are used. A missing website field never replaces independent searches.
"""
import hashlib
import re
from datetime import datetime, timezone
from urllib.parse import urlparse

def allowed_profile(url):
    try:
        p=urlparse(url)
        return (p.scheme=='https' and p.netloc=='floridabarmonitor.com'
            and not p.query and not p.fragment
            and bool(re.fullmatch(r'/attorney/[0-9]+-[a-z0-9-]+',p.path)))
    except (ValueError,TypeError):return False

def contact(raw,lead,now=None):
    from law_local.worker import reader,norm,normalize_phone,clearly_non_private_practice
    if not allowed_profile(lead.get('source_url','')) or lead.get('state')!='FL':
        return None
    def clean(value):
        value=re.sub(r'<(script|style)\b[^>]*>.*?</\1>', '',value,flags=re.S|re.I)
        return ' '.join(' '.join(reader(value).parts).split())
    text=clean(raw)
    fields={clean(k):clean(v) for k,v in re.findall(
        r'<dt\b[^>]*>(.*?)</dt>\s*<dd\b[^>]*>(.*?)</dd>',raw,re.S|re.I)}
    bar_id=urlparse(lead['source_url']).path.split('/')[2].split('-')[0]
    if not re.search(r'Florida Bar\s*#\s*'+bar_id+r'\b',text):return None
    if 'Currently licensed and eligible to practice law in Florida' not in text:return None
    dates=re.findall(r'Last successful check:\s*(\d{1,2} [A-Za-z]{3} \d{4})',text)
    if len(dates)!=1:return None
    try:
        checked=datetime.strptime(dates[0],'%d %b %Y').replace(tzinfo=timezone.utc)
        age=((now or datetime.now(timezone.utc))-checked).total_seconds()
        if not 0<=age<=14*86400:return None
    except ValueError:return None
    firm=fields.get('Firm','')
    h1=re.search(r'<h1\b[^>]*>(.*?)</h1>',raw,re.S|re.I)
    principal=clean(h1.group(1)) if h1 else ''
    is_solo=firm in ('','—','-')
    identity=principal if is_solo else firm
    position=fields.get('Position','')
    private=(position=='Private Law Practice' or
        (not is_solo and bool(re.search(r'(?i)\b(?:law|attorneys?|lawyers?)\b',firm))
         and position in ('Managing Partner','Partner','Owner','Sole Practitioner')))
    phone=normalize_phone(fields.get('Business phone',''))
    if (not private or clearly_non_private_practice(identity)
        or norm(identity)!=norm(lead.get('firm',''))
        or not phone or phone!=normalize_phone(lead.get('phone',''))
        or not re.search(r'\bCounty\b',fields.get('City',''))
        or 'Non-Florida' in text or 'Non-US' in text):return None
    website=fields.get('Website')
    # Missing/malformed fields are unresolved hints, never absence proof.
    hints=[] if website in ('—','-') else [website or 'missing_website_field']
    return {'attorneys':0,'emails':[],'website_candidates':hints,
        'scoped_contact_matched':True,'fl_private_contact':{
            'firm':identity,'phone':phone,'bar_id':bar_id,
            'source_url':lead['source_url'],'status_checked_at':checked.isoformat(),
            'private_practice_confirmed':True,
            'source_sha256':hashlib.sha256(raw.encode()).hexdigest()}}

def export_proof_matches(row,evidence):
    from law_local.worker import norm,normalize_phone
    proof=evidence.get('fl_private_contact',{})
    try:
        age=(datetime.now(timezone.utc)-datetime.fromisoformat(proof['status_checked_at'])).total_seconds()
        return (allowed_profile(row['source_url']) and row['state']=='FL'
            and proof.get('source_url')==row['source_url']
            and norm(proof.get('firm'))==norm(row['firm'])
            and normalize_phone(proof.get('phone'))==normalize_phone(row['phone'])
            and proof.get('private_practice_confirmed') is True and 0<=age<=14*86400
            and bool(re.fullmatch('[a-f0-9]{64}',proof.get('source_sha256',''))))
    except (KeyError,ValueError,TypeError):return False
