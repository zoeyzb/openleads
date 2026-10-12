# Mac local law lead controller — October 12, 2026
Run from macOS, not Railway or Render. The existing law_local worker and SQLite are used without modifying core verification behavior.

- campaign.py: bounded source discovery, state retry ledger, lock, local verification, strict-only export. Florida and New York excluded as fresh-area defaults because prior research already covered Florida and NY grouping is not firm count.
- sync_sheet.py: non-destructive, stable-key Google Sheets upsert; fails closed until LAW_SHEETS_CREDENTIALS points to a service account JSON with access to the existing Sheet.
- test_campaign.py: five isolated strict-export tests.

Run: python3 ops/local_law/campaign.py export ; python3 -m unittest discover -s ops/local_law -q

Local existing launchd schedule points at ~/lead-workspace/campaign.py, not this repository file. Copy reviewed changes to that path when upgrading. Do not commit any credentials, SQLite DB, raw emails or candidate CSV. Do not conflate candidate counts, calling_qualified and strict_eligible. Search-provider negative controls must pass and source email must be attributed to the firm before strict promotion. Main repository PolyForm Noncommercial license governs use; obtain commercial-use authorization before commercial deployment.
