# OpenLeads law scraper — current state, 2026-10-18 UTC

The current user contract is **US law firm + source-supported firmwide 2–10 attorneys + independently screened no owned website + source-published usable email**. Phone-only is separate and also requires firmwide size. Earlier any-size/phone-first instructions are superseded.

- Canonical Mac project: `/Users/zainabhassnain/lead-workspace/openleads`, GitHub `zoeyzb/openleads`, branch `recover-scrape-mcp`.
- Data: original private `~/lead-workspace/law-leads.sqlite3`; existing research catalog reused. No Railway, Render or paid hosting.
- Baseline labels were 3 strict and 9 combined calling. Evidence review corrected this to **1 strict and 0 additional verified phone-only**. Eight prior claims remain preserved as headcount reviews. This is a quality correction, not newly generated volume.
- Source discovery, Maps headcount verification, scoped email recovery and provider health timeout repaired. The hourly launchd label now runs the repository module directly. Local Gosom and SearXNG containers are running.
- Tests: 151 law + 143 operations passed. Live source runs have produced new unverified Maps candidates; **zero new strict leads** at this checkpoint. Do not conflate discovery, emails, or software tests with qualification.
- **1,000 / 10,000 not reached.** Main limitation is firmwide-size/contact/source intersection, including renamed firms and provider coverage. Mac must stay awake for hourly work.

See [repair specification, evidence and remaining work](ops/local_law/REPAIR_2026-10-18.md). Prior status and former hosting configuration are preserved in Git history.
