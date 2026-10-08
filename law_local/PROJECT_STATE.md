# Law acquisition — verified state (2026-10-08)

## Owner's current hard eligibility gates

1. A real US law practice, business identity verified.
2. Firm attorney size **2–10**, supported by a firm-specific public source (not a search-snippet guess or unrelated roster).
3. **No owned website**, supported by successful independent checks. Ambiguous/outage = review, never eligible.
4. A **source-published, usable-format business phone** that matches the firm's identity. Format and publishing checks do NOT prove a completed call/line connectivity.

**Email is optional and must NEVER block the calling-eligible list.** These rules replace older 2026-10-02 email-required project notes. Do not create false positives or silently loosen phone, source, size, and website checks to reach 10,000.

## No-host architecture

- Primary code: private `zoeyzb/openleads` branch `recover-scrape-mcp`, directory `law_local/`.
- PR #31 added local SQLite source verifier; PR #32 corrected the email gate and added bounded Bing RSS discovery.
- GitHub Actions workflow `.github/workflows/law-phone-acquisition.yml` on `main` checks out the source branch and executes a **bounded** research pass, with private 14-day SQLite/CSV artifact. It is not an always-on daemon. Avoid Railway, Render, and paid hosting.
- Source tracker: `Recover Revenue — Law Lead Live Tracker` plus two archive sheets. Private business-phone-only candidate seed: `law_local/private_seed_firms_20261008.csv`.

## Measured 2026-10-08 outcomes

1. Run 37741041667: 18 Bing RSS legal-directory queries returned 0 URLs and 0 fresh candidates. Script returned success because zero hits are not an exception; discovery throughput remains broken.
2. Run 37741321425: imported 161 unique existing calling candidates; attempted first 90. **0 eligible**, 41 unverified firm identities, 46 unverified attorney counts, 3 inconclusive.
3. Merged primary and backup archives (firm+phone pairs), identifying **292** distinct published-phone candidate records.
4. Run 37741491714: imported 131 extra records into persisted SQLite, scanned the remaining 202; full current inventory results = **123 unverified identity, 146 unverified attorney count, 23 inconclusive, 0 eligible**. Source pages often do not establish the purported headcount. These are not qualified leads.
5. Offline tests: 21 passed in the GitHub acquisition job; tests mock third-party sites and are not live headcount evidence.

## Highest-priority blockers

- **Acquisition yield:** Bing RSS search query adapter returned zero directory URLs. Do not repeat it unchanged; replace or diversify with source-specific directory discovery.
- **Bad input provenance:** old CSV/Sheets headcount labels lack confirmed page-level firm proof. Use firm-scoped size and bar/directory evidence; never count candidates as verified on the spreadsheet's numeric assertion.
- **Available coverage:** archive inventory 292 candidates is orders of magnitude below the 10,000 qualified target; original 18k+ Redis inventory is not automatically synced into the free SQLite worker, and access to it is not proven after Railway removal.
- **Phone semantics:** published number + valid US-format is NOT a test call or guaranteed live voice line. Further validation would need compliant telephony, not assumed proof.
- **Compute:** GitHub Actions private-repo quotas and artifact retention are limited; no continuous, no-cost production runtime has been established. Never promise 10k without measured acquisition conversion.

## Next implementation targets

1. Build a source-specific discovery adapter with measured nonzero provider output and published phone, before large-scale reruns.
2. Audit rejection examples against source pages and differentiate parsing failures from nonexistent headcount evidence.
3. Import a larger **real** candidate set only if provenance is verified; dedupe by firm and published phone, with state/address disambiguation.
4. Keep production lead count at zero until source, firm size, no owned website and published phone evidence all pass. Keep separate raw/candidate/review counts, and do not claim solved merely because CI passes.

## Links

- [Phone-first implementation PR #32](https://github.com/zoeyzb/openleads/pull/32)
- [First zero-yield discovery run](https://github.com/zoeyzb/openleads/actions/runs/37741041667)
- [Latest full inventory recheck](https://github.com/zoeyzb/openleads/actions/runs/37741491714)

## 2026-10-08 later verification and acquisition evidence

- PR #33 (merged): diversified Bing RSS and DuckDuckGo legal-directory search providers and firm-profile URL paths. GitHub CI passed, but in live run 37742651214 the 12 additional queries returned **0 usable new profiles**.
- PR #34 (merged): parse actual source page heading/phone and strict 2–10 firm-size intervals. Reject a size range including 1 or above 10. Regression tests passed.
- PR #35 (merged): label firm "Visit Site" relative redirect as a review blocker; exclude directory support email from firm email evidence. Regression tests passed.
- Run 37742651214 revalidated all 292 previously archived candidates after parser change, still **0 passing**; 123 firm identity misses, 146 insufficient firm-size evidence, 23 inconclusive. Honest conversion not repaired by superficial regex changes.
- Run 37742776226 ran the MIT-licensed Gosom Google Maps scraper as an actual bounded GitHub Actions pilot, without Railway or Render: **160** real business records, **2** with published phone and no Maps website field, **0** with verified 2–10 firm size. The two candidates were Stan Schwieger Law Office (Waco TX) and Vasqez Law Office (Amarillo TX). Neither can be promoted to calling-qualified: firm size remains unverified. Zero Maps website field is insufficient as proof of no owned website.
- PR #36 (merged after CI): the primary **calling_qualified** export/count combines entries with published phone, verified 2–10 size, independent no-owned-website evidence, regardless of whether email exists. The separate `strict_eligible` subset also requires published MX-checked email. This preserves the phone-first calling goal without mislabeling an email-unverified record as strict eligible. No email lookup can be used as a blocker for calling-qualified output.
- First-party ABA 2024 Legal Technology Survey observed **91%** website adoption among responding firms with 2–9 attorneys (survey; not a complete national census). Targeting 10,000 no-website firms of this size is therefore a sparse-market acquisition problem, not an issue fixed merely by parallelism.
- The separate large Recover 350k lead spreadsheets are labeled home-service businesses (HVAC/plumbing); importing them into the law pool would be miscategorization.
- The connected Supabase `recover-revenue-os` inventory returned zero current raw_leads and contacts in project table summaries, so it is not a proven source of the historical 18k law records. Supabase flagged public.sheet_acquisition_ranked_snapshot as RLS disabled; inspect role grants/policies and remediate separately, not blindly.

### Current truth / 10,000 target

**0 newly verified calling-qualified firms from these live runs.** **2 Maps no-site-field phone leads are only unverified candidate records.** Do not report the 292 spreadsheet candidates or 160 raw Maps listings as 2–10/no-site phone-qualified. GitHub CI tests prove software behavior only. An unbounded zero-cost 10,000-lead run is not established. GitHub private Actions minutes/artifact retention are quota-limited. No tasks are continuously running after a completed workflow.

### Next evidence-driven step

Preserve free/no-Railway/no-Render requirement. Improve candidate discovery only after measuring per-source real yield: target secondary rural markets, confirm Google Maps omissions against independent search, then source-match official bar/directory attorney rosters before promoting records. At 2 no-site candidates per 160 scraped business records in the initial small-sample pilot, scaling the exact unchanged strategy has weak economics. Keep evidence links, clear failure reason, deduplication and provenance in any subsequent batch.

- [Merged profile parser PR #34](https://github.com/zoeyzb/openleads/pull/34)
- [Merged site/third-party-email safeguard PR #35](https://github.com/zoeyzb/openleads/pull/35)
- [Phone-qualified calling export PR #36](https://github.com/zoeyzb/openleads/pull/36)
- [Latest archive revalidation run 37742651214](https://github.com/zoeyzb/openleads/actions/runs/37742651214)
- [Actual Maps pilot run 37742776226](https://github.com/zoeyzb/openleads/actions/runs/37742776226)


## 2026-10-08 source-yield findings (latest)

- PR #37 merged: direct-source Lawyer.com crawl to bypass zero-result search engines. Run 37807122494 fetched 40 real pages, extracted 12 firm-and-phone-size candidates, but 10 had possible owned sites and 2 were inconclusive. Zero qualified.
- PR #38 merged: persist discovered firm URLs in a SQLite frontier and prioritize them over directory index pages. Main GitHub Actions workflow restores the latest completed checkpoint even after zero-yield failure.
- Run 37807707978 fetched 100 pages including 84 actual firm profiles, yet parsed only 1 as published size 2–10 plus business phone. That 1 entered website review, NOT qualified. Counts: 123 unverified identity, 146 unverified size, 25 inconclusive, 11 website review, 0 calling-qualified.
- PR #39 merged: explain real source rejection by one-attorney, range-including-one, missing-size, missing-phone and parser-mismatch categories. See new direct_discovery.profile_rejection_reasons in run logs before scaling. Tests passed.
- The highest blocker is source quality and strict no-owned-website verification, not worker concurrency. General lawyer.com profiles often have firm size 1 or a Visit Site link. Firm-scoped bar directory member pages, e.g. https://www.inbar.org/members/?id=29049614, sometimes explicitly provide 2-10 attorney range and firm phone; investigate as candidate source but still independently verify no owned site.
- Real 10,000-goal status is STILL ZERO qualified. No Railway/Render/paid services. Never infer positive firm size from roster count guesses or absent owned-site evidence.

- Follow-up production diagnosis [run 37808518212](https://github.com/zoeyzb/openleads/actions/runs/37808518212): 100 pages fetched (0 fetch failures); 85 were individual firm profiles. Exactly 45 sources explicitly reported size 1, 40 had no explicit firm-size evidence, 0 met 2–10 size+firm phone parsing. New qualified firms = 0; total still 0. This rejects scaling unchanged Lawyer.com state/county discovery. Find a source which exposes firm-specific 2–10 size at discovery time; official bar firm-size fields are a promising but not yet validated alternative, with owned-site screening still mandatory.


## 2026-10-08 later phone/email-verified acquisition repairs

- Merged PR #40: add a firm-size-first public state-bar member directory parser, preserving source-published 2–10 attorney and professional phone provenance. GitHub test suite passed, but live acquisition run 37827232893 measured **14/14 HTTP 403** responses from inbar.org, so the host is blocked in this runner and MUST NOT be repeated unchanged. Disabled this bar-source step in main GitHub workflow; not counted as an acquisition source. The single fixture event in unit-test logs is a MOCK, not a real lead.
- Audit run 37827591261 read 11 persisted website-review records: all 11 included specific firm-owned website links on published Lawyer.com firm profiles (not generic redirect placeholders). They remain excluded/review, not qualified. Examples: Acker Warren links ackerwarren.com, Cain & Kiel links cklfirm.com.
- Merged PR #41, test jobs successful: `law_local/maps_first.py` creates a distinct unverified Maps queue from actual Maps listings with missing website field + valid published business phone, then verifies independent published firm identity, *matching exact phone* and 2–10 size before adding to the main SQLite verifier. No Maps absence is treated as final proof. Evidence survives a failed acquisition job.
- The main acquisition workflow retrieves the latest Maps pilot artifact and runs strict headcount/phone matching; the Maps discovery pilot expanded from 8 to 20 geographically diverse city searches in `.github/workflows/law-maps-pilot.yml`. Automatic `workflow_run` handoff launches new firm verification once the Maps pilot finishes. No Railway/Render/paid hosting was used; GitHub Actions quotas remain limited.
- First real main handoff run 37828265862 imported **2 Maps no-site-field phone candidates**, probed **8 real directory profile URLs**, found **0** matching third-party 2–10/identity/phone sources and **0 qualified**. These 2 are NOT calling-ready or strict email-eligible.
- Main workflow now separately exports `state/call-qualified-law.csv` (source-published phone + 2–10 + independent no-owned-site checks; email optional) and `state/email-eligible-law.csv` (all of the above plus source-published usable email) with distinct counters. **Strict eligible always requires email.** No leads can be promoted based only on phone or missing Maps website metadata.
- `0 / 10,000` is still the last verified eligible count; GitHub test pass is not evidence of live source yield. The new expanded Maps pilot is finite and cannot guarantee 10,000; do not report its raw listing or candidate counts as verified.
