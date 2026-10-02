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

## Verification checklist
- [ ] Railway law-pipeline deployment succeeds for commit c875d148...
- [ ] service stays healthy and heartbeat resumes
- [ ] new roster-identity counters/logs appear
- [ ] size-ready backlog is reprocessed
- [ ] unique source-verified email count rises above the pre-change baseline of 42, or logs prove the new lane executes without unsafe acceptance
- [ ] unique eligible count is checked separately; do not claim success from call-ready growth

## Known operational risk
Railway UI currently shows the subscription as past due. Services are online at this checkpoint, but billing suspension could interrupt the pipeline independently of code quality.

## Next action
Verify the deployment and production counters. If roster identities execute but verified emails remain flat, inspect the exact source-stage loss (search result discovery vs page identity/context vs MX vs owned-site rejection) before changing another gate or adding more volume.
