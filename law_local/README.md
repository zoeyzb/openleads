# Law leads without Railway, Render, Redis or a hosted worker

This folder contains a **standalone source-first law-firm lead pipeline**.
It can run locally on Python 3.10+ and as a bounded GitHub-hosted Actions job,
with real HTTP access, no Railway/Render/Redis/paid VM, and a persisted SQLite
checkpoint uploaded as a GitHub Actions artifact. It does **not** send outreach.
The public repository itself is not a safe private lead database: don't commit
raw firm/emails/SQLite to its Git history. GitHub artifact retention is currently
90 days, not permanent, and account quotas/timeouts still apply.

This new tool is independent of the old Redis-based law pipeline; that pipeline
is still in the repository for compatibility, but is **not started** by these
commands. The old 18k+ inventory was not transferred into this local SQLite DB.
GitHub contains code/tests plus old public-business seed rows; the private historical Redis inventory is NOT recovered.

## Quick start

From the repository root on a Mac or Linux computer:

```bash
python3 -m unittest discover -s law_local -v
python3 -m law_local.florida_roster --db "$HOME/law-leads.sqlite3" --max-pages 156 --max-profiles 300 --seconds 440
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
need their column names adapted. The primary acquisition path is now `florida_roster`: it fetches the real
published Florida-law-directory firm-index pages, filters firms with 2–10
**active attorneys**, and checks the same firm's published office phone on
the actual firm page. Each profile enters `pending`, NOT call/email eligible.
The old search engine/guessed Lawyer.com discovery is deprecated for production.
All records are checkpointed in `fl_roster_frontier` to avoid scanning the same
firm twice. The last real first source-first run (#37841289197) discovered
4,955 candidate URLs, checked 320, and admitted 291 size+phone candidates.
These are **NOT** no-owned-site or source-email-verified contacts. A failed
search-provider positive control leaves candidates pending rather than making
unfounded negative-website claims.

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

### Bounded GitHub production runs (no Railway/Render)

- Acquisition workflow: [Law phone-first acquisition (bounded)](https://github.com/zoeyzb/openleads/actions/workflows/law-phone-acquisition.yml).
- Source census: [Law source quality census](https://github.com/zoeyzb/openleads/actions/workflows/law-source-census.yml).
- The production workflow restores the latest completed (including zero-yield failure) `law-phone-state` artifact, appends a source-first Florida roster batch, checks search-provider health, conditionally performs strict final website/email verification, and uploads a 90-day state artifact.
- `roster-sourced-size-phone.csv` is only the **source-backed size+phone stage**. `call-qualified-law.csv` requires the independent no-owned-site gate; `email-eligible-law.csv` also requires a published usable/MX-checked email.
- `CALLING_QUALIFIED_TOTAL` and `VERIFIED_EMAIL_ELIGIBLE_TOTAL` MUST be reported separately. No stage count should be called verified outreach-ready when it lacks hard proof.
- Google Sheets is a user-facing contact queue with legacy counts labelled as historical; it is **not automatically synced** by this standalone runner without a configured sheet writer.

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
