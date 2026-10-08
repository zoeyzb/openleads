"""Standalone, no-hosting law-lead qualification with SQLite and public evidence.

This is NOT the historical Redis daemon. It will not import Redis queues
magically or assert that absent search results prove a website cannot exist.
Only records with a published firm/phone/size source plus two independent
successful negative web searches may enter its screened lists.
"""
from __future__ import annotations

import argparse
import csv
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
from html import unescape
from html.parser import HTMLParser
import json
import re
import sqlite3
from pathlib import Path
import subprocess
import time
from urllib.parse import urlencode, urlparse, parse_qs, unquote
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

USER_AGENT = "OpenLeads-Law-Evidence/1.0 (+https://github.com/zoeyzb/openleads)"
DIRECTORY_DOMAINS = (
    "lawyers.com", "lawyer.com", "avvo.com", "justia.com", "inbar.org",
    "findlaw.com", "martindale.com", "superlawyers.com",
    "floridabar.org", "americanbar.org", "lawinfo.com",
    "facebook.com", "linkedin.com", "instagram.com", "youtube.com",
    "yelp.com", "google.com", "bing.com", "duckduckgo.com",
    "mapquest.com", "yellowpages.com", "chamberofcommerce.com",
    "bbb.org", "nolo.com", "legalmatch.com", "law.com"
)
EMAIL_RE = re.compile(r"(?i)\b[A-Z0-9._%+\-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b")
PHONE_RE = re.compile(r"(?<!\d)(?:\+?1[\s.()\-]*)?([2-9]\d{2})[\s.()\-]*([2-9]\d{2})[\s.\-]*(\d{4})(?!\d)")
NON_EMAIL_PREFIXES = ("noreply@", "no-reply@", "donotreply@", "example@", "test@")
BLOCKED_SUFFIXES = (".example", ".invalid", ".test", ".localhost")

def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

def norm(value):
    return " ".join(re.findall(r"[a-z0-9]+",str(value or "").lower()))

def normalize_phone(value):
    digits=re.sub(r"\D", "", str(value or ""))
    if len(digits)==11 and digits[0]=="1":
        digits=digits[1:]
    if len(digits)!=10 or digits[0] not in "23456789" or digits[3] not in "23456789":
        return ""
    if len(set(digits))==1 or digits in {"1234567890","0000000000"}:
        return ""
    # NANP 555-0100...0199 numbers are reserved for fiction.
    if digits[3:6]=="555" and 100<=int(digits[6:])<=199:
        return ""
    return digits

class TextReader(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts=[]
        self.links=[]
        self.href=None
        self.anchor=[]
    def handle_starttag(self,tag,attrs):
        if tag.lower()=="a":
            self.href=dict(attrs).get("href")
            self.anchor=[]
    def handle_data(self,data):
        self.parts.append(data)
        if self.href is not None:
            self.anchor.append(data)
    def handle_endtag(self,tag):
        if tag.lower()=="a" and self.href is not None:
            self.links.append((self.href," ".join(self.anchor)))
            self.href=None
            self.anchor=[]

def reader(html):
    p=TextReader()
    p.feed(str(html or "")[:500000])
    return p

def firm_identity_matches(html,lead):
    p=reader(html)
    text=norm(" ".join(p.parts))
    firm=norm(lead.get("firm",""))
    phone=normalize_phone(lead.get("phone",""))
    published={normalize_phone(m.group()) for m in PHONE_RE.finditer(" ".join(p.parts))}
    # Never match a phone by concatenating unrelated page digits.
    return bool(firm and len(firm)>=8 and firm in text and phone and phone in published)

def _third_party(host):
    host=host.lower().removeprefix("www.")
    return any(host==domain or host.endswith("."+domain) for domain in DIRECTORY_DOMAINS)

def _public_http_url(url):
    parsed=urlparse(str(url or ""))
    return parsed.scheme in ("https","http") and bool(parsed.netloc) and not (
        parsed.hostname in ("localhost","127.0.0.1","0.0.0.0","::1")
    )

def evaluate_published_source(html,lead):
    """Require actual firm name AND exact published phone before trusting size/email."""
    if not firm_identity_matches(html,lead):
        return {"attorneys":0,"emails":[],"website_candidates":[]}
    p=reader(html)
    raw_text=" ".join(p.parts)
    text=norm(raw_text)
    firm=norm(lead["firm"])
    # Only accept explicit firm-size wording, not "attorneys for plaintiff".
    size_pattern=rf"\b{re.escape(firm)}\s+(?:has|employs|includes|comprises)\s+(\d{{1,2}})\s+attorneys?\b"
    m=re.search(size_pattern,text)
    # Third-party firm profiles commonly use an explicit "Firm Size: N"
    # field rather than a prose sentence. Require an identity/phone match
    # first and do not interpret client counts or generic search snippets.
    attorney_range=None
    if not m:
        # Interpret an explicit firm-size *range* as a range; do not claim its
        # lower bound is the exact number or accept "1-5" as 2+.
        range_match=re.search(r"\b(?:firm size|office size|firm/organization size)\s*:?\s*(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\b",raw_text,re.I)
        if range_match:
            lo,hi=map(int,range_match.groups())
            if 2<=lo<=hi<=10:
                attorney_range=(lo,hi)
                attorneys=lo
            else:
                attorneys=0
        else:
            m=re.search(r"\b(?:firm size|firm/organization size|number of attorneys|attorneys at this firm)\s*:?\s*(\d{1,2})(?!\s*(?:\+|[-–]|to\b|employees?\b|staff\b))\s*(?:attorneys?|lawyers?)?\b",raw_text,re.I)
            attorneys=int(m.group(1)) if m else 0
    else:
        attorneys=int(m.group(1))
    # Emails must be literally published in this identity-matched page.
    emails=sorted(set(v.lower() for v in EMAIL_RE.findall(unescape(html))))
    # Provider footer addresses are not prospect contact evidence.
    emails=[v for v in emails if not v.startswith(NON_EMAIL_PREFIXES)
            and not v.split("@")[-1].endswith(BLOCKED_SUFFIXES)
            and not _third_party(v.split("@")[-1])]
    external=[]
    for href,label in p.links:
        if not re.search(r"(?i)\b(?:website|official site|visit site|firm site)\b",label or ""):
            continue
        if not href or href.strip() in ("#","/"):
            continue
        try:
            parsed=urlparse(href)
            if parsed.scheme in ("http","https") and parsed.hostname:
                if not _third_party(parsed.hostname):
                    external.append(href)
                elif "redirect" in parsed.path or "url=" in (parsed.query or ""):
                    external.append("directory_site_redirect:"+href)
            elif href.startswith("/") or href.startswith("?"):
                # Relative site links in directories are frequently redirects.
                # We cannot safely label such firms 'no owned website'.
                external.append("directory_site_link:"+href[:250])
            elif href.lower().startswith("javascript:"):
                external.append("directory_site_js_link")
        except ValueError:
            external.append("unparseable_website_link")
    return {"attorneys":attorneys,"attorney_range":attorney_range,"emails":emails,"website_candidates":sorted(set(external))}

def search_target(url):
    """Unwrap DuckDuckGo result redirects before deciding site ownership."""
    try:
        p=urlparse(url)
        if p.hostname and p.hostname.lower() in ("duckduckgo.com","www.duckduckgo.com"):
            target=parse_qs(p.query).get("uddg",[""])[0]
            return unquote(target) if _public_http_url(unquote(target)) else ""
    except ValueError:
        return ""
    return url

def classify_search_results(search_results):
    """Both independent providers must answer with parseable evidence."""
    if len(search_results)<2 or not all(r.get("responded") is True for r in search_results[:2]):
        return {"status":"inconclusive","reason":"search_provider_unavailable"}
    potential=[]
    for result in search_results[:2]:
        for raw_url in result.get("urls",[]):
            try:
                url=search_target(raw_url)
                host=urlparse(url).hostname or ""
                if _public_http_url(url) and not _third_party(host):
                    potential.append(url)
            except ValueError:
                continue
    if potential:
        return {"status":"review_website","reason":"possible_owned_site","urls":sorted(set(potential))[:10]}
    return {"status":"screened_no_site","reason":"two_completed_negative_searches"}

def evaluate_candidate(lead,source_html,search_results,mx_check):
    source=evaluate_published_source(source_html,lead)
    evidence={"firm":lead.get("firm",""),"phone":normalize_phone(lead.get("phone","")),
              "source_url":lead.get("source_url",""),"headcount_source":lead.get("source_url",""),
              "attorneys":source["attorneys"],"attorney_range":source.get("attorney_range"),"email":"","email_source":"",
              "checked_at":utc_now(),"site_status":""}
    # A firm-controlled source URL is itself proof of an owned website,
    # even if both search engines mistakenly return no results.
    host=urlparse(str(lead.get("source_url",""))).hostname or ""
    if not _third_party(host):
        return {**evidence,"status":"owned_site_or_untrusted_source"}
    if not firm_identity_matches(source_html,lead):
        return {**evidence,"status":"unverified_identity"}
    if source["attorneys"]<2 or source["attorneys"]>10:
        return {**evidence,"status":"unverified_size"}
    if source["website_candidates"]:
        return {**evidence,"status":"review_website","website_candidates":source["website_candidates"]}
    site=classify_search_results(search_results)
    evidence["site_status"]=site["status"]
    if site["status"]!="screened_no_site":
        return {**evidence,"status":site["status"],"site_evidence":site}
    # PHONE-FIRST CONTRACT: email is an optional, source-published bonus.
    # Missing/invalid email never disqualifies an independently verified
    # law firm with 2-10 attorneys, a published phone, and no owned site.
    for email in source["emails"]:
        domain=email.rsplit("@",1)[-1]
        try:
            ok=bool(mx_check(domain))
        except Exception:
            ok=False
        if ok:
            evidence["email"]=email
            evidence["email_source"]=lead.get("source_url","")
            break
    # The calling list requires published phone, size and no owned site.
    # Preserve separate stricter eligibility for source-published usable email.
    return {**evidence,"status":"strict_eligible" if evidence["email"] else "call_qualified_no_email"}

class SqliteQueue:
    def __init__(self,path):
        path=Path(path).expanduser().resolve()
        path.parent.mkdir(parents=True,exist_ok=True)
        self.conn=sqlite3.connect(path)
        self.conn.row_factory=sqlite3.Row
        self.conn.executescript("""
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS candidates (
                id TEXT PRIMARY KEY,
                firm TEXT NOT NULL,
                phone TEXT NOT NULL,
                city TEXT NOT NULL DEFAULT '',
                state TEXT NOT NULL DEFAULT '',
                source_url TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                attempts INTEGER NOT NULL DEFAULT 0,
                result_json TEXT NOT NULL DEFAULT '{}',
                updated TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status);
        """)
        # Re-evaluate old records previously rejected solely for no email.
        self.conn.execute("UPDATE candidates SET status='pending', attempts=0 WHERE status='call_ready_no_email'")
        self.conn.commit()
    @staticmethod
    def _id(lead):
        key="|".join([norm(lead.get("firm")),normalize_phone(lead.get("phone")),norm(lead.get("state"))])
        return hashlib.sha256(key.encode()).hexdigest()[:24]
    def add(self,lead):
        if not lead.get("firm") or not normalize_phone(lead.get("phone")) or not _public_http_url(lead.get("source_url")):
            return False
        cur=self.conn.execute("""INSERT OR IGNORE INTO candidates
                (id,firm,phone,city,state,source_url,updated)
                VALUES (?,?,?,?,?,?,?)""",
            (self._id(lead),lead["firm"].strip(),normalize_phone(lead["phone"]),
             str(lead.get("city","")).strip(),str(lead.get("state","")).strip(),
             str(lead["source_url"]).strip(),utc_now()))
        self.conn.commit()
        return cur.rowcount>0
    def pending(self,limit):
        rows=self.conn.execute("""SELECT * FROM candidates
             WHERE status='pending' OR (status='inconclusive' AND attempts < 3)
             ORDER BY updated ASC LIMIT ?""",(int(limit),)).fetchall()
        return [dict(row) for row in rows]
    def record(self,lead,result):
        self.conn.execute("""UPDATE candidates
             SET status=?, attempts=attempts+1,result_json=?,updated=?
             WHERE id=?""",
             (result["status"],json.dumps(result,sort_keys=True),utc_now(),self._id(lead)))
        self.conn.commit()
    def counts(self):
        totals=dict(self.conn.execute("SELECT status,COUNT(*) FROM candidates GROUP BY status").fetchall())
        totals["calling_qualified"]=totals.get("strict_eligible",0)+totals.get("call_qualified_no_email",0)
        return totals
    def export(self,status,path):
        statuses=("strict_eligible","call_qualified_no_email") if status=="calling_qualified" else (status,)
        placeholders=",".join("?" for _ in statuses)
        rows=self.conn.execute(f"""SELECT firm,phone,city,state,source_url,result_json
             FROM candidates WHERE status IN ({placeholders}) ORDER BY state,firm""",statuses).fetchall()
        path=Path(path).expanduser()
        path.parent.mkdir(parents=True,exist_ok=True)
        cols=["Firm","Phone","City","State","Attorneys","Email","Headcount source","Email source","Website audit","Checked at"]
        with path.open("w",newline="",encoding="utf-8") as fd:
            w=csv.DictWriter(fd,fieldnames=cols)
            w.writeheader()
            for row in rows:
                evidence=json.loads(row["result_json"])
                w.writerow({
                    "Firm":row["firm"],"Phone":row["phone"],"City":row["city"],"State":row["state"],
                    "Attorneys":evidence.get("attorneys",""),"Email":evidence.get("email",""),
                    "Headcount source":evidence.get("headcount_source",""),
                    "Email source":evidence.get("email_source",""),
                    "Website audit":evidence.get("site_status",""),
                    "Checked at":evidence.get("checked_at","")
                })
        return len(rows)
    def close(self):
        self.conn.close()

def fetch_public(url,timeout=9):
    if not _public_http_url(url):
        raise ValueError("Not a public HTTP URL")
    request=Request(url,headers={"User-Agent":USER_AGENT,"Accept":"text/html,application/rss+xml"})
    with urlopen(request,timeout=timeout) as response:
        if response.status!=200:
            raise ValueError("HTTP "+str(response.status))
        data=response.read(450000)
        return data.decode("utf-8",errors="replace")

def _links_from_html(html):
    p=reader(html)
    links=[]
    for u,label in p.links:
        try:
            parsed=urlparse(u)
            if parsed.scheme in ("http","https") and parsed.hostname:
                links.append(u)
            elif parsed.hostname:
                links.append(u)
        except ValueError:
            pass
    return links[:35]

def search_for_firm(lead):
    term='\"'+str(lead["firm"]).replace('"',"")+'\" \"'+normalize_phone(lead["phone"])+'\" website'
    queries=[
        "https://www.bing.com/search?format=rss&"+urlencode({"q":term}),
        "https://html.duckduckgo.com/html/?"+urlencode({"q":term})
    ]
    out=[]
    for index,url in enumerate(queries):
        try:
            page=fetch_public(url,timeout=8)
            if index==0:
                root=ET.fromstring(page)
                items=root.findall(".//item")
                responded=root.tag.lower().endswith("rss") or bool(items)
                links=[(item.findtext("link") or "").strip() for item in items]
            else:
                responded="duckduckgo" in page.lower() and (
                    "result__a" in page.lower() or "no results" in page.lower()
                )
                links=_links_from_html(page)
            out.append({"responded":bool(responded),"urls":[v for v in links if _public_http_url(v)]})
        except Exception:
            out.append({"responded":False,"urls":[]})
    return out

def domain_has_mail(domain):
    if not re.fullmatch(r"(?i)[a-z0-9.-]{4,253}",domain):
        return False
    try:
        p=subprocess.run(["nslookup","-type=mx",domain],
                         timeout=5,text=True,capture_output=True,check=False)
        return p.returncode==0 and bool(re.search(r"(?i)(mail exchanger|exchanger\s*=|MX preference)",p.stdout))
    except (OSError,subprocess.TimeoutExpired):
        return False

def process_candidate(lead):
    try:
        html=fetch_public(lead["source_url"])
        if not firm_identity_matches(html,lead):
            return {"status":"unverified_identity","source_url":lead["source_url"],"checked_at":utc_now()}
        source=evaluate_published_source(html,lead)
        search=search_for_firm(lead) if 2<=source["attorneys"]<=10 and not source["website_candidates"] else []
        return evaluate_candidate(lead,html,search,mx_check=domain_has_mail)
    except Exception as exc:
        return {"status":"inconclusive","reason":str(exc)[:200],"checked_at":utc_now()}

def run_batch(db,max_rows=100,workers=4,seconds=600):
    deadline=time.monotonic()+max(1,int(seconds))
    total={}
    concurrency=max(1,min(8,int(workers)))
    # Freeze distinct ids at start: an inconclusive lookup gets a retry on the
    # next run, never 3 wasted retries in a single outage window.
    candidates=db.pending(int(max_rows))
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        for offset in range(0,len(candidates),concurrency):
            if time.monotonic()>=deadline:
                break
            batch=candidates[offset:offset+concurrency]
            future_to_lead={pool.submit(process_candidate,row):row for row in batch}
            for future in as_completed(future_to_lead):
                lead=future_to_lead[future]
                try:
                    result=future.result()
                except Exception as exc:
                    result={"status":"inconclusive","reason":str(exc)[:200],"checked_at":utc_now()}
                db.record(lead,result)
                total[result["status"]]=total.get(result["status"],0)+1
                print(json.dumps({"event":"law_local_lead_processed","firm":lead["firm"],"status":result["status"]}),flush=True)
    return total

def import_csv(db,path):
    added=0
    with Path(path).expanduser().open(newline="",encoding="utf-8-sig") as fd:
        for row in csv.DictReader(fd):
            lead={
                "firm":row.get("firm") or row.get("Firm") or row.get("name") or row.get("Name") or "",
                "phone":row.get("phone") or row.get("Phone") or "",
                "city":row.get("city") or row.get("City") or "",
                "state":row.get("state") or row.get("State") or "",
                "source_url":row.get("source_url") or row.get("Headcount Source") or row.get("Headcount source") or ""
            }
            added+=int(db.add(lead))
    return added


DISCOVERY_STATES = {
    "AL":"Alabama","AK":"Alaska","AZ":"Arizona","AR":"Arkansas",
    "CA":"California","CO":"Colorado","CT":"Connecticut","DE":"Delaware",
    "FL":"Florida","GA":"Georgia","HI":"Hawaii","ID":"Idaho",
    "IL":"Illinois","IN":"Indiana","IA":"Iowa","KS":"Kansas",
    "KY":"Kentucky","LA":"Louisiana","ME":"Maine","MD":"Maryland",
    "MA":"Massachusetts","MI":"Michigan","MN":"Minnesota","MS":"Mississippi",
    "MO":"Missouri","MT":"Montana","NE":"Nebraska","NV":"Nevada",
    "NH":"New Hampshire","NJ":"New Jersey","NM":"New Mexico",
    "NY":"New York","NC":"North Carolina","ND":"North Dakota",
    "OH":"Ohio","OK":"Oklahoma","OR":"Oregon","PA":"Pennsylvania",
    "RI":"Rhode Island","SC":"South Carolina","SD":"South Dakota",
    "TN":"Tennessee","TX":"Texas","UT":"Utah","VT":"Vermont",
    "VA":"Virginia","WA":"Washington","WV":"West Virginia",
    "WI":"Wisconsin","WY":"Wyoming"
}

def discovery_queries(states):
    """Small, diverse queries covering both actual Lawyer.com firm URL forms."""
    for state in states:
        state=str(state).upper().strip()
        if state not in DISCOVERY_STATES:
            raise ValueError("Unknown US state abbreviation: "+state)
        name=DISCOVERY_STATES[state]
        for source in ("lawyer.com/firm", "lawyer.com/firms"):
            for practice in ("firm size", "family law", "estate planning", "criminal law"):
                yield state, f'site:{source} {name} {practice}'


def _discovery_result_url(url):
    if url.startswith("//"):
        url="https:"+url
    if not _public_http_url(url):
        return ""
    target=search_target(url)
    host=(urlparse(target).hostname or "").lower().removeprefix("www.")
    path=urlparse(target).path.lower()
    if host=="lawyer.com" and (path.startswith("/firm/") or path.startswith("/firms/")):
        return target
    return ""


def _search_directory_profiles(query):
    """Try public Bing RSS and DDG HTML; never treat anti-bot as no results."""
    attempts=0
    raw_urls=[]
    for provider,url in (
        ("bing","https://www.bing.com/search?"+urlencode({"q":query,"format":"rss"})),
        ("duck","https://html.duckduckgo.com/html/?"+urlencode({"q":query}))
    ):
        try:
            html=fetch_public(url,timeout=12)
            if provider=="bing":
                root=ET.fromstring(html)
                if not root.tag.lower().endswith("rss"):
                    continue
                urls=[(item.findtext("link") or "").strip() for item in root.findall(".//item")]
            else:
                low=html.lower()
                if "result__a" not in low and "no results" not in low:
                    continue
                p=reader(html)
                urls=[link for link,label in p.links]
            attempts+=1
            raw_urls.extend(urls)
        except Exception:
            continue
    if attempts==0:
        raise ValueError("No responsive discovery providers")
    results=[_discovery_result_url(url) for url in raw_urls]
    return list(dict.fromkeys(url for url in results if url))


def _extract_directory_profile(url,html):
    """Produce a candidate ONLY when the profile itself binds firm/phone/size."""
    if not _public_http_url(url):
        return None
    # Lawyer.com often has a phone-number H1 and a Resources H1 before
    # the actual firm H1. Use the heading immediately preceding the target
    # firm's explicitly published Firm Size field, not the first H1.
    size_pos=re.search(r"(?is)firm\s*size\s*:?",html)
    preceding=html[:size_pos.start()] if size_pos else html
    headings=re.findall(r"(?is)<h1\b[^>]*>(.*?)</h1>",preceding)
    headings=[" ".join(unescape(re.sub(r"(?is)<[^>]+>"," ",heading)).split()) for heading in headings]
    headings=[h for h in headings if len(norm(h))>=8 and not re.fullmatch(r"[\d()+.\s-]+",h)
              and norm(h) not in {"resources","need legal help quickly","find a lawyer"}]
    if not headings:
        return None
    firm=headings[-1][:150]
    text=" ".join(reader(html).parts)
    # Only accept the firm's 'Call NNN-NNN-NNNN' contact number. Do not
    # mistake the directory's 800-620-0900 banner/footer for the firm.
    call_number_re=re.compile(r"\bCall\s+((?:\+?1[\s.()\-]*)?\(?[2-9]\d{2}\)?[\s.()\-]*[2-9]\d{2}[\s.\-]*\d{4})",re.I)
    phones=list(dict.fromkeys(normalize_phone(m.group(1)) for m in call_number_re.finditer(text)))
    for phone in phones[:3]:
        if not phone:
            continue
        candidate={"firm":firm,"phone":phone,"city":"","state":"","source_url":url}
        if 2<=evaluate_published_source(html,candidate)["attorneys"]<=10:
            return candidate
    return None


def discover_candidates(db,states,max_queries=20,max_pages=100,seconds=480,delay=1.2,
                        search_fn=None,fetch_fn=None):
    """Resumable local discovery; results remain candidates until live no-site audit."""
    search_fn=search_fn or _search_directory_profiles
    fetch_fn=fetch_fn or fetch_public
    db.conn.execute("""CREATE TABLE IF NOT EXISTS discovery_queries (
        query TEXT PRIMARY KEY, completed_at TEXT NOT NULL, urls INTEGER NOT NULL,
        added INTEGER NOT NULL)""")
    db.conn.commit()
    deadline=time.monotonic()+max(1,seconds)
    counts={"queries":0,"pages":0,"candidates_added":0,"provider_failures":0}
    # Deterministic order and persisted completed queries prevent same-area loops.
    for state,query in discovery_queries(states):
        if counts["queries"]>=max_queries or counts["pages"]>=max_pages or time.monotonic()>=deadline:
            break
        done=db.conn.execute("SELECT 1 FROM discovery_queries WHERE query=?",(query,)).fetchone()
        if done:
            continue
        try:
            urls=search_fn(query)
        except Exception as exc:
            counts["provider_failures"]+=1
            print(json.dumps({"event":"discovery_search_failed","query":query,"error":str(exc)[:120]}),flush=True)
            # Leave query retryable if provider was down.
            continue
        counts["queries"]+=1
        added=0
        for url in urls:
            if counts["pages"]>=max_pages or time.monotonic()>=deadline:
                break
            try:
                html=fetch_fn(url,timeout=10)
                counts["pages"]+=1
                candidate=_extract_directory_profile(url,html)
                if candidate:
                    candidate["state"]=state
                    if db.add(candidate):
                        added+=1
                        counts["candidates_added"]+=1
            except Exception:
                counts["pages"]+=1
            if delay>0:
                time.sleep(delay)
        # Only checkpoint a fully-scanned query; interrupted queries retry.
        if counts["pages"]<max_pages and time.monotonic()<deadline:
            db.conn.execute("INSERT OR REPLACE INTO discovery_queries VALUES (?,?,?,?)",
                            (query,utc_now(),len(urls),added))
            db.conn.commit()
        print(json.dumps({"event":"discovery_query","state":state,"query":query,
                          "found_urls":len(urls),"added":added}),flush=True)
        if delay>0:
            time.sleep(delay)
    return counts

def main(argv=None):
    parser=argparse.ArgumentParser(description="Local law-firm lead verifier: no Redis, cloud host, or paid API")
    parser.add_argument("--db",default="./law-leads.sqlite3")
    sub=parser.add_subparsers(dest="cmd",required=True)
    p=sub.add_parser("import",help="Import real candidate names/phones and their public source URLs")
    p.add_argument("csv")
    p=sub.add_parser("run",help="Perform bounded public verification research")
    p.add_argument("--max",type=int,default=100)
    p.add_argument("--workers",type=int,default=4)
    p.add_argument("--seconds",type=int,default=600)
    p=sub.add_parser("discover",help="Find new public law-directory candidates, resumably")
    p.add_argument("--states",default="FL,TX,CA,NY,IL,GA,PA,OH,NC,MI")
    p.add_argument("--max-queries",type=int,default=20)
    p.add_argument("--max-pages",type=int,default=100)
    p.add_argument("--seconds",type=int,default=480)
    p.add_argument("--delay",type=float,default=1.2)
    p=sub.add_parser("export",help="Export screened verified leads only")
    p.add_argument("--status",choices=["calling_qualified","strict_eligible","call_qualified_no_email"],default="calling_qualified")
    p.add_argument("--out",default="./strict-law-leads.csv")
    sub.add_parser("stats")
    args=parser.parse_args(argv)
    db=SqliteQueue(args.db)
    try:
        if args.cmd=="import":
            print(json.dumps({"imported":import_csv(db,args.csv),"counts":db.counts()}))
        elif args.cmd=="run":
            print(json.dumps({"batch":run_batch(db,args.max,args.workers,args.seconds),"counts":db.counts()}))
        elif args.cmd=="discover":
            states=[s.strip().upper() for s in args.states.split(",") if s.strip()]
            print(json.dumps({"discovery":discover_candidates(db,states,args.max_queries,args.max_pages,
                                     args.seconds,args.delay),"counts":db.counts()}))
        elif args.cmd=="export":
            print(json.dumps({"exported":db.export(args.status,args.out),"output":args.out,"status":args.status}))
        elif args.cmd=="stats":
            print(json.dumps({"counts":db.counts()}))
    finally:
        db.close()

if __name__=="__main__":
    main()
