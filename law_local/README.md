# Law leads without Railway, Render, Redis or a hosted worker

This folder is a **local-only, source-verification CLI**. It runs on a
network-connected computer with Python 3.10+ and stores all progress in one
local SQLite file. No paid APIs, Docker, hosted Redis, PostgreSQL or cloud VM
are required. It does **not** send outreach.

This new tool is independent of the old Redis-based law pipeline; that pipeline
is still in the repository for compatibility, but is **not started** by these
commands. The old 18k+ inventory was not transferred into this local SQLite DB.
GitHub contains code/tests, not that private inventory.

## Quick start

From the repository root on a Mac or Linux computer:

```bash
python3 -m unittest discover -s law_local -v
python3 law_local/worker.py --db "$HOME/law-leads.sqlite3" discover --states FL,TX,CA,NY,IL --max-queries 20 --max-pages 100 --seconds 480
python3 law_local/worker.py --db "$HOME/law-leads.sqlite3" import /path/to/candidates.csv
python3 law_local/worker.py --db "$HOME/law-leads.sqlite3" run --max 1000 --workers 4 --seconds 7200
python3 law_local/worker.py --db "$HOME/law-leads.sqlite3" export --status calling_qualified --out "$HOME/call-qualified-law.csv"
python3 law_local/worker.py --db "$HOME/law-leads.sqlite3" stats
```

`--seconds 7200` caps **new batch scheduling** at two hours; an already
submitted, small chunk may finish slightly afterward. Your computer must be
awake and have Internet access while it runs.

### Candidate input

The CSV needs real published business details and an attributable third-party
law directory or bar source:

```csv
firm,phone,city,state,source_url
```

Do not put made-up rows or guessed emails into the input. Existing CSVs may
need their column names adapted. The `discover` subcommand searches a bounded set of public legal-directory pages,
retains only profiles with a matching published firm, usable-format phone,
and explicit 2–10 attorney evidence, and persists its query checkpoints in SQLite.
It is a **new, unproven public-search discovery adapter**, not a guarantee of
1,000 or 10,000 qualified leads. Run the `run` command afterward to verify
absence of an owned website. Search provider errors cause retries, not invented leads.
A no-input or unavailable-provider run can legitimately report zero processed. This is a portable evidence
gate, **not** a verified 1,000-lead acquisition system.

### Eligibility (strict)

An export row requires all of the following:

1. A source page from a recognized third-party public legal directory or bar.
2. An exact firm identity and a matching published US phone on that page.
3. An explicit firm-attorney count from 2–10 on that source page.
4. A bounded two-provider negative owned-website search, with **both providers
   responding successfully**. Owned-site hints trigger review, not acceptance.
Email is OPTIONAL for the **calling-qualified** pool. The export status `calling_qualified` combines verified phone-only firms (`call_qualified_no_email`) with the smaller `strict_eligible` subset that also has a source-published MX-checked email. Missing email never blocks the calling pool.
Historical `call_ready_no_email` rows are automatically requeued for screening. A published phone's syntax is screened, but
this process does **not** place a call to verify that it actually rings.

A no-website search is an *evidence-based screening*, not logical proof that
no website exists anywhere; ambiguous firms must be manually reviewed. Website
search anti-bot pages and network errors yield `inconclusive`, not a lead.

### Why this cannot be run on GitHub-hosted Actions

GitHub-hosted Actions are used only to test the code. The production research
job needs network access and persistent local files, so run it on your own Mac,
or a self-hosted runner on your own computer if you later choose that route.

The current ChatGPT file container has **no outbound DNS**, and GitHub is
connected only for repository operations. Neither grants access to your Mac.
Running or testing fixtures here does not produce real leads.

### Safety and limitations

- Rate limits and provider terms apply. Keep concurrency low.
- Store the SQLite file and CSV privately; never commit prospect emails to a
  public repo.
- The local worker intentionally fails closed when it lacks source/website
  evidence. High volumes of unverified firms **do not count** toward the target.
- The discovery adapter is intentionally conservative, rate-limited and subject
  to provider outages, robots policy and public-directory availability. The
  workflow has **not** been live-proven to find 1,000 or 10,000 qualified firms.
  A hosted GitHub Actions runner is an optional limited execution path, with
  private-repository usage deducted from account quotas; it is not unlimited
  free compute.
