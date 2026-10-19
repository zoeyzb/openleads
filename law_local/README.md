# Law leads without Railway, Render, Redis or a hosted worker

This folder contains a **standalone source-first law-firm lead pipeline**.
It can run locally on Python 3.10+ and as a bounded GitHub-hosted Actions job,
with real HTTP access, no Railway/Render/Redis/paid VM, and a persisted SQLite
checkpoint uploaded as a GitHub Actions artifact. It does **not** send outreach.
The public repository itself is not a safe private lead database: don't commit
raw firm/emails/SQLite to its git history. GitHub artifact retention is currently
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
python3 law_local/worker.py --db "$HOME/law-leads.sqlite3" export --status strict_eligible --out "$HOME/email-eligible-law.csv"
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
need their column names adapted. The primary acquisition path is `florida_roster`: it fetches the real
published Florida-law-directory firm-index pages and admits firms with a
published office phone on the actual firm page. **Attorney count is optional
metadata** when present (solo, unknown, and larger firms are all allowed); it
never blocks discovery, enrichment, qualification, or export.
Each profile enters `pending`, NOT email-qualified. Records are checkpointed in
`fl_roster_frontier` to avoid scanning the same firm twice. A failed
search-provider positive control leaves candidates pending rather than making
unfounded negative-website claims.

### Eligibility

**Email-qualified (`strict_eligible`)** — all required:

1. A real, active **U.S. private law firm** (government, non-law employers, and ambiguous identities excluded).
2. Source-attested firm identity and published US business phone on the source page.
3. **No owned website**, supported by **two independent search providers** (DuckDuckGo Lite + relevance-validated Bing RSS) both responding successfully. Failed or throttled searches → `inconclusive`, never qualified.
4. A **source-published usable email** on the same attested page (or joined FL Bar proof after site clearance), with **MX validation** and saved attribution in `result_json`.
5. Deduplication by firm + phone + state hash; evidence persisted on the row.

**Phone-only (`call_qualified_no_email`)** — same as above except email is not required. Exported separately from `strict_eligible`. Never counted as email-qualified.

Attorney count fields (`attorneys`, `attorney_range`) are exported for research only.

Historical `call_ready_no_email` and **`unverified_size`** rows are automatically requeued when SQLite opens so size policy changes can re-run without losing website or identity exclusions.

A no-website search is an *evidence-based screening*, not logical proof that
no website exists anywhere; ambiguous firms must be manually reviewed.

### Bounded GitHub production runs (no Railway/Render)

- Acquisition workflow: [Law phone-first acquisition (bounded)](https://github.com/zoeyzb/openleads/actions/workflows/law-phone-acquisition.yml).
- Source census: [Law source quality census](https://github.com/zoeyzb/openleads/actions/workflows/law-source-census.yml).
- The production workflow restores the latest completed (including zero-yield failure) `law-phone-state` artifact, appends a source-first Florida roster batch, checks search-provider health (known **owned** domain positive control), conditionally performs strict final website/email verification, and uploads a 90-day state artifact.
- `roster-sourced-size-phone.csv` is the **source-backed phone research stage** (optional attorney counts). `call-qualified-law.csv` requires the independent no-owned-site gate; `email-eligible-law.csv` requires source-published MX-checked email.
- `CALLING_QUALIFIED_TOTAL`, `email_qualified` / `VERIFIED_EMAIL_ELIGIBLE_TOTAL` MUST be reported separately.

### Safety and limitations

- Never treat directory support emails, footer addresses, or guessed permutations as qualified.
- Never treat Maps “no website field” as proof of no owned site.
- GitHub Actions minutes and artifact retention are finite; Mac workers should reuse SQLite checkpoints and saved `search_results` in `result_json` before re-scraping.
