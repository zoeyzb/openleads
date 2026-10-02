# Recover Law Lead Pipeline — Project Status

Last updated: 2026-10-02

## Goal
Build a durable nationwide law-firm lead pipeline. A lead is eligible only when all four gates are verified:
1. Law firm.
2. No owned website.
3. 2–10 attorneys, backed by source evidence.
4. Source-verified usable email.

Phone-only/call-ready records are intermediate candidates, not eligible leads.

## Current deployed architecture
Railway project: Recover Scrape Clean.
Primary services: law-pipeline, recover-scrape-mcp, acquisition-worker-g, maps-gosom, scrapling, Redis.
Deployed source: `zoeyzb/openleads`, branch `recover-scrape-mcp`.

## Baseline before the 2026-10-02 roster-identity fix
Observed from production logs immediately before the change:
- strict qualified / unique eligible: 3
- call-ready (2–10, no site, usable phone; email optional): 177
- unique source-verified emails: 42
- unique verified headcounts: about 1,608 and rising
- current email candidates: 3
- size-ready email backlog: about 127–154
- verified-email count remained flat while verified headcount kept rising

This proves the active bottleneck is source-verified email discovery for already size-qualified/no-site firms, not raw discovery or headcount throughput.

## Important failed/weak approaches
- Increasing headcount throughput alone: headcounts rose rapidly but strict eligible count stayed flat.
- Repeating broad Bing/Duck queries: very high query/link volume with almost no new raw email candidates.
- Treating call-ready as equivalent to eligible: rejected. Email remains a hard gate.
- Relaxing source verification or inventing/pattern-guessing addresses: prohibited.

## 2026-10-02 change
Commit: `c875d1489c9098cd748e7feb69a4a09bcaa1bfbc`
Purpose: use verified Lawyer.com/headcount-page attorney roster identities during strict email recovery.

Changes:
- bumped size-ready email method to `size-ready-email-v4-headcount-roster-identities` so existing size-ready firms can be retried with the new method;
- when an identity-matched headcount source exposes an attorney/team roster, preserve those names even if that page contains no email;
- merge those verified attorney names into `directory_attorney_names`, which feeds state-bar/public-record search queries;
- stopped discarding Lawyer.com roster names merely because the same page already had an explicit Firm Size value;
- did not relax any eligibility, MX, source-binding, website, or headcount gate.

## 2026-10-02 capacity/backpressure change
Commit: `f24575a086a63117a2c5faf2ed77993a352c0cd9`

Observed before this change, one deployment launched a size-ready batch of 96 at concurrency 48 and a general batch of 256 at concurrency 80 at the same time. Both lanes then crossed the stall threshold. This was resource contention, not proof that more concurrency meant more throughput.

Change:
- strict size-ready batch capped at 64, concurrency capped at 32;
- while any size-ready backlog exists, general enrichment is capped at 64 records and concurrency 16;
- when the strict backlog drains, general enrichment returns to its configured limits;
- no eligibility gate was changed.

Verified after deployment:
- Railway deployment succeeded.
- Runtime selected strict batch 64 / concurrency 32.
- Runtime selected general batch 64 / concurrency 16 while `sizeReadyBacklog=188`.
- The strict-email lane is therefore receiving reserved network capacity instead of competing with 80 simultaneous headcount workers.

## Verification checklist
- [x] Railway deployment succeeds for roster-identity commit c875d148...
- [x] Railway deployment succeeds for backpressure commit f24575a...
- [x] service boots and heartbeat resumes
- [x] size-ready method v4 requeues the existing strict backlog
- [x] adaptive runtime caps are active (strict 64/32, general 64/16 under pressure)
- [ ] wait for completed post-change cycles and compare cycle latency/yield
- [ ] confirm the new roster identities create additional source-verified email candidates
- [ ] unique source-verified email count rises above the pre-change baseline of 42
- [ ] unique eligible count is checked separately; do not claim success from call-ready growth

Important correctness observation: a previously call-ready firm was later found to have an owned website and was rejected. Strict eligible count moved from 3 to 2 during revalidation. That is a quality correction, not a regression to hide.

## Known operational risk
Railway UI currently shows the subscription as past due. Services are online at this checkpoint, but billing suspension could interrupt the pipeline independently of code quality.

## Next action
Let the lower-contention strict batch complete and compare its latency/yield against the pre-change multi-minute stalls. If verified emails remain flat after the v4 roster pass, inspect the exact source-stage loss (search result discovery vs page identity/context vs MX vs owned-site rejection). California Bar is a known secondary target: canonical profile links are being found, but profile identity matching is still rejecting them before email acceptance; fix that only with strong name/geo/profile evidence, never by relaxing source verification.
