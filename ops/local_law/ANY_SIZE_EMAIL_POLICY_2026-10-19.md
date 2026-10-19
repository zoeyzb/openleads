# Current qualification policy — 2026-10-19

The owner explicitly removed ALL attorney-count requirements. Solo, unknown-size and large private law firms can qualify. Count/range is optional metadata; it must not gate discovery, processing, promotion, counts, exports or Harvey sync.

A strict lead still requires real US private law-firm identity, matched public contact evidence, independently screened no owned website, a literally source-published usable email/MX, deduplication and dated evidence. Calling-only output stays separate. Government, non-law, inactive and owned-site holds remain blocked.

Implementation uses the original Mac SQLite queue, existing research catalog, existing hourly launchd service and local SearXNG/Maps. No paid hosting, new daemon or second canonical database.

Acceptance: solo/unknown/large firms pass when all remaining proof passes; missing email cannot enter strict; website and identity failures cannot qualify. One-time size-only requeue preserves prior JSON and adverse holds. Source-first PLEA cards must bind the SAME firm, phone and email, and direct published-mail-domain HTTP checks flag possible owned websites.

Target: 10,000 genuinely qualified leads. This is a target, not a measured result. Current state and measured runs are appended below.

## Implementation and measured execution

Backups including SQLite WAL state were taken before mutation. The initial live export/count was 1 strict email lead and 0 additional valid phone-only leads. The user's earlier 3/9 labels were not independently valid under the previous contract.

Removed count bounds from the canonical verifier, directory/Maps/NY/bar/Common Crawl discovery, manual-source promotion, exports, counts and strict CRM mirroring. Requeued 85 size-only holds for fresh checks; prior JSON and adverse exclusions were preserved. Fixed archive bridge starvation and bounded the published-email candidate backlog. The existing hourly job now imports up to 25 source-email candidates and verifies up to 60 with two workers and a 240-second work budget.

Three manual live verification batches processed 180 candidates: 153 website-review results, 20 inconclusive, 1 identity failure, 1 phone-only result, and 5 provisional strict results. These are batch outcomes, not retained qualified counts. A later direct email-domain check excluded CHELF LAW; broader name/phone searches also flagged Rhonda Cates and Marshall Nash. All three remain website review, not qualified. Broader scans can conservatively hold directory/editorial hits for ownership review; they never certify absence.

Fresh checks retained A. Liotto Law and Jeffrey Weiner with source-bound published emails/MX and independent website searches. The existing Napier/Wolf/Popejoy proof is preserved within its evidence freshness window despite a new Martindale 403; failed refreshes are recorded in candidate_check_history and cannot silently replace valid proof. Every retained export is revalidated against evidence and deduplication, not raw labels.

NY live discovery: 1 public page, 100 source groups, 98 valid-phone research records, 6 possible private firms; no qualified leads created. Washington public Bar adapter fetched the previously observed active Moore Appellate profile successfully, with typed professional email/phone; the identity already existed, so 0 new unique candidates in that pilot. It now rotates bounded city queries with persistent checkpoints and accepts actual returned member URLs only. Missing website fields do not qualify either source.

Florida Bar email pilot was blocked by unavailable/forbidden robots policy, producing 0 contacts and 0 strict leads. It was not bypassed or repeatedly retried. Common Crawl's current index request was unavailable; the existing saved URL frontier still supplied candidates.

Regression suites: 158 core tests and 147 operations tests passed (305 total). They cover solo/unknown/large firm eligibility, government/inactive/owned-site rejection, scoped email binding, dedupe, policy migration, provider deadlines, aliases/phone positive-only checks and typed official Bar contacts. Unit test mocks are not live source evidence.

## Remaining bottlenecks

10,000 strict leads remain a target. Removing size gates expands the candidate pool but does not manufacture public emails or prove website absence. The current PLEA catalog contains only 334 firms; Maps and the recovered 9,037-source archive mostly supply research without published emails. Many apparent no-site listings have a website under a different label or active custom email domain. Source 403s, indexed profile coverage and email publication are the main constraints. The hourly worker continues bounded source discovery and evidence verification on the Mac; throughput cannot support a credible promise of 1,000 or 10,000 from these measured runs alone.

NY pagination also now advances beyond already completed pages on later bounded runs and separates page-size checkpoints; a small pilot cannot hide the rest of a larger production page.

## Final snapshot — 2026-10-19 UTC

- Strict email-qualified: **3**, up from **1** (+2 genuinely new retained leads).
- Additional phone-only: **1**; verified contact union **4**. These are separate exported lanes.
- Canonical queue: **760** unique candidates, up from **543** (+217). Separately, the NY pilot stored 98 research source groups; those are not qualified.
- Four live batches processed **240** candidates. Batch outcomes: 209 website reviews, 21 inconclusive, 1 identity failure, 1 untrusted/owned-source failure, 6 provisional email-qualified and 2 provisional phone-only. Subsequent source/website/affiliation checks retained only 2 of those new email leads and 1 phone-only lead. Kyle Thompson is held for unresolved current private-practice identity; one additional provisional phone row failed the wider website recheck. Failed provisional rows are excluded from final totals.
- Source-published email + MX + all retained requirements: **2 new leads / 240 processed (0.83%)**. Public email availability was not measured for website-rejected rows because they failed before the email stage; do not imply those rows lack email.
- Attorney-count verification yield: **not applicable**, removed by the owner; unknown/solo/large sizes are permitted.
- Native launchd cycle completed successfully with exit 0 in **313.87 seconds**; website-provider controls usable; local Maps and SearXNG running. Hourly scheduling stays enabled at 3600 seconds. Metrics publisher is enabled at 600 seconds and its latest run succeeded. New Washington adapter is included in future cycles and was live-tested separately during this cycle.
- Core tests **158 passed**, operations tests **147 passed**; **305 total**. git diff --check passed. Exports and strict local CRM sync were refreshed after final holds; outbound remains disabled.

The 10,000 target is **9,997 short**, and the first 1,000 milestone is not reached. The scheduled Mac pipeline continues; target attainment is not promised by these results.
