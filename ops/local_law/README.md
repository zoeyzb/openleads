# Mac law pipeline

Current contract: attorney count is optional. Strict leads require real US private law-firm identity, matched public business phone, literally source-published usable email/MX, independently screened no owned website, dated evidence and deduplication. Phone-only and unverified research remain separate. See [project state](../../SCRAPER_PROJECT_STATUS.md) and [current run report](ANY_SIZE_EMAIL_POLICY_2026-10-19.md).

The canonical queue is `~/lead-workspace/law-leads.sqlite3`; research is in the existing sibling `research_catalog.sqlite3`. Never commit these databases, prospect CSVs, credentials or personal configuration.

Install the existing hourly launchd job with `python3.11 -m ops.local_law.install_worker`. It runs `python3.11 -m ops.local_law.campaign` from the repository. Do not copy campaign.py to a second scheduled entrypoint. `company.recoverrevenue.metricsfeed` likewise runs the repository module `ops.local_law.publish_metrics` every ten minutes and publishes aggregate-only metrics.

The campaign takes a nonblocking lock, applies the evidence-preserving size-policy migration, prioritizes published-email contacts, advances archive/Maps/source discovery checkpoints, processes bounded verifier batches, exports and mirrors strict records to the existing local CRM. It does not initiate outreach. Failed/blocked sources cool down; they never certify no website. No Railway, Render or paid hosting is used.

```sh
/opt/homebrew/bin/python3.11 -m ops.local_law.campaign export
/opt/homebrew/bin/python3.11 -m unittest discover -s law_local
/opt/homebrew/bin/python3.11 -m unittest discover -s ops/local_law
```

Private files: `strict-qualified-law.csv` contains strict email leads; `phone-only-law.csv` contains only the additional no-email lane; `call-qualified-law.csv` is their verified union. `law-research-1000-UNVERIFIED.csv` is source research, not 1,000 qualified leads.

Previous diagnostics and failed approaches remain in [the prior repair report](REPAIR_2026-10-18.md) and git history. Their former 2–10 eligibility rules are superseded.
