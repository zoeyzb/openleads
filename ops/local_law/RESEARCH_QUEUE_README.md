# Private 1,000-firm verification research queue

Run from the repository root:

```sh
/opt/homebrew/bin/python3.11 -m ops.local_law.export_review_shortlist
```

This refreshes `~/lead-workspace/law-research-1000-UNVERIFIED.csv` **locally**. The Mac's existing hourly campaign controller also refreshes it. It is never uploaded to the public Git repository or to the public aggregate metrics Gist. The original local `source_research` database remains the source of truth and is not modified by this export.

Exactly 1,000 source-linked *research prospects* are selected when enough records remain, with up to 500 from Florida roster sources and 500 from NY attorney-registration groups to avoid a Florida-only national queue. It deduplicates normalized firm name + business phone and rejects known-website evidence, review failures, obvious generic non-firms, public agencies, NGOs and in-house counsel. Each row labels:

- `Firmwide size verified=NO`: a count of attorneys registered in one state does NOT establish total firm size.
- `No owned website verified=NO`: absence of a directory website link does NOT establish absence of an owned site.
- `Qualified for calling=NO`: these prospects cannot be transferred into `call-qualified-law.csv` until independent website and firmwide-size checks pass in the actual worker.

All three verification gates are the explicit default, never derived from an arbitrary scoring model. The CSV includes the original public source URL for every entry, and never contains fabricated phone/email information. If independent evidence confirms an owned website, record it in `research_catalog.sqlite3.external_evidence` under kind `owned_website`; the next refresh automatically excludes that firm. The private calling and strict exports remain separate.

Pilot after 2026-10-16 recovery: 1,000 distinct research rows, 500 FL / 500 NY. Further web checks found existing owned firm websites for A to Z Injury Law PLLC, Abad Constancio & Mallonga LLC and A&G Law Group PLLC; their attributed evidence is recorded in the catalog so they do not reappear in the research shortlist. This pilot did NOT yield any verified calling-qualified firms.
