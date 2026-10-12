"""Index existing historical research snapshots without promoting any row to calling-qualified."""
from __future__ import annotations
import sqlite3,hashlib,json,re
from pathlib import Path
from datetime import datetime,timezone

ROOT=Path.home()/"lead-workspace"
FL=ROOT/"research_archives/fl/law-leads.sqlite3"
NY=ROOT/"research_archives/ny/ny-attorney-registrations.sqlite3"
INDEX=ROOT/"research_catalog.sqlite3"

def norm(s):
    return " ".join(re.findall(r"[a-z0-9]+",str(s or "").lower()))
def identity(firm,phone,state):
    digits=re.sub(r"\D","",str(phone or ""))
    if len(digits)==11 and digits.startswith("1"):digits=digits[1:]
    return hashlib.sha256((norm(firm)+"|"+digits+"|"+norm(state)).encode()).hexdigest()[:24]
def ensure(c):
    c.executescript("""
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS source_research (
        lead_id TEXT PRIMARY KEY,
        firm TEXT NOT NULL, phone TEXT NOT NULL,city TEXT NOT NULL,
        state TEXT NOT NULL,source_url TEXT NOT NULL,source TEXT NOT NULL,
        reported_attorneys INTEGER, headcount_scope TEXT NOT NULL,
        proof_status TEXT NOT NULL DEFAULT 'needs_firmwide_size_and_owned_site',
        found_in_sources TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_research_stage ON source_research(proof_status,state);
    CREATE TABLE IF NOT EXISTS source_inventory (
        source TEXT PRIMARY KEY,coverage TEXT,rows_seen INTEGER,updated_at TEXT
    );
    """)
def ingest():
    if not FL.exists() or not NY.exists():
        raise FileNotFoundError("Restore both named GitHub Actions artifacts before indexing")
    dest=sqlite3.connect(INDEX)
    ensure(dest)
    # Rebuild from exact independently archived evidence; nothing goes into the verified call queue.
    dest.execute("DELETE FROM source_research")
    dest.execute("DELETE FROM source_inventory")
    now=datetime.now(timezone.utc).isoformat(timespec="seconds")
    def add(firm,phone,city,state,url,source,count,scope):
        lid=identity(firm,phone,state)
        if not lid or not norm(firm) or not phone:return
        old=dest.execute("SELECT found_in_sources FROM source_research WHERE lead_id=?",(lid,)).fetchone()
        if old:
            src=set(old[0].split(","))|{source}
            dest.execute("UPDATE source_research SET found_in_sources=? WHERE lead_id=?",(",".join(sorted(src)),lid))
        else:
            dest.execute("""INSERT INTO source_research
            (lead_id,firm,phone,city,state,source_url,source,reported_attorneys,headcount_scope,found_in_sources,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)""",(lid,firm,phone,city or "",state or "",url,source,count,scope,source,now))
    fl=sqlite3.connect(FL)
    florida=fl.execute("""
        SELECT c.firm,c.phone,c.city,c.state,c.source_url,f.listed_attorneys
        FROM candidates c JOIN fl_roster_frontier f ON c.source_url=f.url
        WHERE f.status='size_phone_source_only'
        AND c.status NOT IN ('review_nonlaw_employer','review_ambiguous_identity')
    """).fetchall()
    for name,phone,city,state,url,count in florida:
        add(name,phone,city,state,url,"FL roster",count,"FL_active_only_not_total_firm_size")
    ny=sqlite3.connect(NY)
    newyork=ny.execute("""
        SELECT company,phone,city,state,source_url,ny_attorneys
        FROM ny_registration_groups WHERE status='possible_private_law_firm'
    """).fetchall()
    for name,phone,city,state,url,count in newyork:
        add(name,phone,city,state,url,"NY registrations",count,"NY_registered_count_not_total_firm_size")
    dest.executemany("INSERT INTO source_inventory VALUES (?,?,?,?)",[
        ("FL roster","156 directory index pages processed in archived run; not proof of no owned website",len(florida),now),
        ("NY registrations","NY attorney group index examined; not proof of nationwide firm headcount",len(newyork),now)
    ])
    dest.commit()
    by_source=dest.execute("SELECT source,COUNT(*) FROM source_research GROUP BY source").fetchall()
    total=dest.execute("SELECT COUNT(*) FROM source_research").fetchone()[0]
    duplicates=len(florida)+len(newyork)-total
    out={"source_rows":len(florida)+len(newyork),"FL_rows":len(florida),
         "NY_rows":len(newyork),"unique_research_contacts":total,
         "duplicate_identity_rows":duplicates,"qualified":0,"by_primary_source":by_source,
         "database":str(INDEX)}
    print(json.dumps(out))
    return out
if __name__=="__main__":ingest()
