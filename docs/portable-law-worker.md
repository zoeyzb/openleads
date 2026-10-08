# Portable law worker: one command, one queue owner

The same worker runs on a laptop, rented VM, or managed Node host. Node.js 22+ and a compatible persistent Redis server are required. No Railway or Render SDK is used.

## Qualification contract

- **Call Ready:** genuine law firm, usable published U.S. telephone number, source-verified 2–10 attorneys and a completed bounded owned-website absence audit. A valid-looking number has **not** been confirmed as an active telephone line.
- **Strict Eligible:** all call-ready requirements plus a source-verified, usable public email address.
- Email enrichment is optional and never blocks the calling lane.
- Two attorney listings sharing one office phone are one exported call target.
- A negative website search is a bounded audit, not proof that a website cannot exist.

## Install

```bash
git clone https://github.com/zoeyzb/openleads.git
cd openleads
git switch recover-scrape-mcp
npm install --omit=dev
```

Set `REDIS_URL` (or `ACQUISITION_REDIS_URL`) using a private environment variable, never commit it. If writing Google Sheets, configure `LAW_LEADS_SHEET_SYNC_ENABLED=true`, `LAW_LEADS_SPREADSHEET_ID` and `GOOGLE_SERVICE_ACCOUNT_JSON` on the host. Sheet sync waits until completion in CLI mode and fails the run if configured sync fails.

## Run one bounded batch

```bash
npm run law:once
```

Default CLI limits: 8 headcount candidates, 4 concurrent lookups, 4 before/after website-audit candidates, 2 concurrent audits. It acquires a Redis lease to prevent two CLI runs overlapping, reports queue counts and exits.

**First run against an existing lead inventory or after a qualification-version migration**:

```bash
npm run law:once -- --bootstrap
```

`--bootstrap` rebuilds law pipeline work sets from stored lead/evidence records. It does **not** delete lead records, verified evidence, or the shared Maps acquisition queue. This is an explicit operation because re-evaluating thousands of records takes time.

If you need additional **source-first** law directory prospects, opt in:

```bash
npm run law:once -- --discover
```

This triggers one bounded Lawyers.com directory cycle, not the generic high-duplicate Maps acquisition pipeline. Discovery may be blocked by rate limits or source outages.

Use `LAW_CLI_BATCH_LIMIT`, `LAW_CLI_CONCURRENCY`, `LAW_CLI_AUDIT_BATCH`, `LAW_CLI_AUDIT_CONCURRENCY` to tune, within hard safety caps (32, 8, 16, 4). Examples:

```bash
LAW_CLI_BATCH_LIMIT=4 LAW_CLI_CONCURRENCY=2 npm run law:once
```

For a long-lived server, `npm run law:daemon` retains the existing daemon workflow. **Never run the CLI and daemon simultaneously against the same Redis**, because the legacy daemon does not participate in the one-shot lease.

## What persists across runs

- Redis lead/evidence hashes, source attempts, eligible/call-ready sets, queue positions and strict-email evidence.
- Google Sheets exports call-ready and strict-email lists, with the append-only archive preserved.
- The process itself retains no important state. A fresh CLI process can resume from Redis.

**Before changing hosting providers, migrate and verify the actual Redis dataset and backup**. GitHub stores source code, *not* the leads already in Redis. A new empty Redis will need importing candidates before any useful headcount work can happen.

## Cost and hosting honesty

The worker is portable; it is not automatically hosted for free. Running it on your own laptop costs no extra cloud compute while your machine remains on. A free VM, if available to your account, can also run it. GitHub Actions are for testing and deployment automation here, **not** continuous commercial scraping.

## Tests

```bash
npm run test:law:cli
```

CI also checks pipeline syntax and the existing law regression suite. Changes on the working branch can be deployed later to any eligible host without rewriting lead qualification logic.
