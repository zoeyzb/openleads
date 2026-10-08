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
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET

USER_AGENT = "OpenLeads-Law-Evidence/1.0 (+https://github.com/zoeyzb/openleads)"
DIRECTORY_DOMAINS = (
    "lawyers.com", "lawyer.com", "avvo.com", "justia.com",
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
    digits=re.sub(r"\D", "", " ".join(p.parts))
    firm=norm(lead.get("firm",""))
    phone=normalize_phone(lead.get("phone",""))
    return bool(firm and len(firm)>=8 and firm in text and phone and phone in digits)

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
    text=norm(" ".join(p.parts))
    firm=norm(lead["firm"])
    # Only accept explicit firm-size wording, not "attorneys for plaintiff".
    size_pattern=rf"\b{re.escape(firm)}\s+(?:has|employs|includes|comprises)\s+(\d{{1,2}})\s+attorneys?\b"
    m=re.search(size_pattern,text)
    attorneys=int(m.group(1)) if m else 0
    # Emails must be literally published in this identity-matched page.
    emails=sorted(set(v.lower() for v in EMAIL_RE.findall(unescape(html))))
    emails=[v for v in emails if not v.startswith(NON_EMAIL_PREFIXES)
            and not v.split("@")[-1].endswith(BLOCKED_SUFFIXES)]
    external=[]
    for href,label in p.links:
        try:
            parsed=urlparse(href)
            if parsed.scheme not in ("https","http") or not parsed.hostname:
                continue
            if _third_party(parsed.hostname):
                continue
            # An outbound 'website' link on the source is evidence of a
            # possible owned site and must NOT be dismissed as a no-site lead.
            if re.search(r"(?i)\b(website|visit site|official site|home page)\b",label):
                external.append(href)
        except ValueError:
            continue
    return {"attorneys":attorneys,"emails":emails,"website_candidates":sorted(set(external))}

def classify_search_results(search_results):
    """Both independent providers must answer with parseable evidence."""
    if len(search_results)<2 or not all(r.get("responded") is True for r in search_results[:2]):
        return {"status":"inconclusive","reason":"search_provider_unavailable"}
    potential=[]
    for result in search_results[:2]:
        for url in result.get("urls",[]):
            try:
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
              "attorneys":source["attorneys"],"email":"","email_source":"",
              "checked_at":utc_now(),"site_status":""}
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
    for email in source["emails"]:
        domain=email.rsplit("@",1)[-1]
        try:
            ok=bool(mx_check(domain))
        except Exception:
            ok=False
        if ok:
            return {**evidence,"status":"strict_eligible",
                    "email":email,"email_source":lead.get("source_url","")}
    return {**evidence,"status":"call_ready_no_email"}

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
             WHERE status='pending' ORDER BY updated ASC LIMIT ?""",(int(limit),)).fetchall()
        return [dict(row) for row in rows]
    def record(self,lead,result):
        self.conn.execute("""UPDATE candidates
             SET status=?, attempts=attempts+1,result_json=?,updated=?
             WHERE id=?""",
             (result["status"],json.dumps(result,sort_keys=True),utc_now(),self._id(lead)))
        self.conn.commit()
    def counts(self):
        return dict(self.conn.execute("SELECT status,COUNT(*) FROM candidates GROUP BY status").fetchall())
    def export(self,status,path):
        rows=self.conn.execute("""SELECT firm,phone,city,state,source_url,result_json
             FROM candidates WHERE status=? ORDER BY state,firm""",(status,)).fetchall()
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
    import_deadline=time.monotonic()+max(1,int(seconds))
    batch=db.pending(max_rows)
    counts={}
    # Bounded concurrency and batch size; no runaway background jobs.
    with ThreadPoolExecutor(max_workers=max(1,min(8,workers))) as pool:
        future_to_lead={pool.submit(process_candidate,row):row for row in batch}
        for future in as_completed(future_to_lead):
            lead=future_to_lead[future]
            try:
                result=future.result()
            except Exception as exc:
                result={"status":"inconclusive","reason":str(exc)[:200],"checked_at":utc_now()}
            db.record(lead,result)
            counts[result["status"]]=counts.get(result["status"],0)+1
            print(json.dumps({"event":"law_local_lead_processed","firm":lead["firm"],"status":result["status"]}),flush=True)
            if time.monotonic()>import_deadline:
                # In-flight small batch completes, but no new batch starts.
                break
    return counts

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
    p=sub.add_parser("export",help="Export screened verified leads only")
    p.add_argument("--status",choices=["strict_eligible","call_ready_no_email"],default="strict_eligible")
    p.add_argument("--out",default="./strict-law-leads.csv")
    sub.add_parser("stats")
    args=parser.parse_args(argv)
    db=SqliteQueue(args.db)
    try:
        if args.cmd=="import":
            print(json.dumps({"imported":import_csv(db,args.csv),"counts":db.counts()}))
        elif args.cmd=="run":
            print(json.dumps({"batch":run_batch(db,args.max,args.workers,args.seconds),"counts":db.counts()}))
        elif args.cmd=="export":
            print(json.dumps({"exported":db.export(args.status,args.out),"output":args.out,"status":args.status}))
        elif args.cmd=="stats":
            print(json.dumps({"counts":db.counts()}))
    finally:
        db.close()

if __name__=="__main__":
    main()
