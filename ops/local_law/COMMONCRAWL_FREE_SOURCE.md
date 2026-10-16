# Zero-key law-firm discovery: Common Crawl + Lawyer.com

This free collector uses the public Common Crawl index to discover **real** `https://www.lawyer.com/firm/*.html` profile URLs, then retrieves only the live public profile pages. It does not need Bing, paid API keys, Redis, Railway, Docker, or a cloud server.

Run on Mac:

```shell
cd ~/lead-workspace/openleads
/opt/homebrew/bin/python3.11 -m ops.local_law.commoncrawl_profiles --max 12
```

The existing Mac launchd controller includes a bounded run of the above each cycle. Source URL dedupe, alphabetic discovery cursors, live fetch attempts, extracted explicit size range/firm name/business phone, and owned-site hints are persisted in the **existing private** `~/lead-workspace/research_catalog.sqlite3`. The calling queue stays in `~/lead-workspace/law-leads.sqlite3` and cannot be qualified based on directory evidence alone. The collector does not overwrite existing sales statuses or put unverified firms into the calling export.

For every profile, `Firm Size: 2-10` (including a range whose minimum is 2 and maximum 10) and a published business phone are necessary to become a **candidate**. If a page has an explicit `Visit Site` link to a firm domain, it is excluded from the no-website pool. Missing `Visit Site` means only *not linked on this page*, **not proof that no website exists**. The normal full verifier still requires independent healthy site searches before it can promote a firm.

Common Crawl indexes are intermittent and incomplete; 404 for a query is an empty partition, 5xx/timeout is retried, and one failed alphabetic partition does not block the others. Source sites may impose robots, rate limits or terms; do not bypass such restrictions. A candidate's live 2–10 firm-size signal from a directory still needs appropriate evidence validation. This is *discovery*, not a guarantee of 1,000 qualified law firms.

First measured Mac batch October 16, 2026: a/b/c index queries yielded 16/20/28 unique URL candidates, and all 64 tested URLs lacked a qualifying explicit size range. Verified calling leads remained zero. Do not relabel these as qualified. No HVAC contacts were merged into the law data.

## October 16 follow-up: correct firm-size and multi-archive recovery

- Corrected the initial parser: firm size can be a **single exact number** (e.g. `Firm Size: 4`) or an explicit range contained entirely within 2–10; values such as 1, 11, `1–5`, `2–25` or absent size do not pass. No implied size is invented from partner names or employee profiles.
- Rechecked all 68 originally indexed pages after the parsing fix. 39 were out of range, 29 lacked supported size, and zero advanced to the website-audit stage. This is the measured pilot result, not a forecast or generated count.
- Added five public nonconsecutive Common Crawl monthly index sources, with unique (`crawl`, `letter`) checkpoints. Previous `CC-MAIN-2026-39` work is migrated idempotently into the new index ledger; indexed URLs still deduplicate globally and no previous research/source/caller record is deleted.
- A failed HTTP 502/timeout on one monthly index now records its error and selects another partition on the following pass; a 404 is accepted as an empty public index partition. No proxy, account rotation or paid API is used. Avoid repeatedly hammering the volunteer-funded index; the current Mac controller runs one bounded request per scheduled cycle.
- Original research archive and law verifier remain separate; no HVAC contacts or unverified candidate rows become qualified leads. The website search remains degraded, and negative owned-site status cannot be established from a directory page merely omitting a link. No free external source tested yet satisfies the **two independent, healthy website searches** requirement at national scale.
