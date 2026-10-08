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
