# Lean Law Call-Ready Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replace the legacy email/recovery loop with a verified phone-first call-ready pipeline and a small, trustworthy operating surface.

**Architecture:** Keep the existing law-pipeline as the single qualification brain and Redis as durable state. Introduce explicit no-owned-site audit state before call readiness, remove legacy recovery/email queues from the critical scheduler, circuit-break poor sources, deduplicate exports by phone, and let Maps/Scrapling sleep unless needed.

**Tech Stack:** Node.js 22, Redis, Railway, Google Sheets API, GitHub Actions.

**Spec:** docs/superpowers/specs/2026-10-08-lean-law-call-ready.md

## Global Constraints
- Call-ready = law firm + usable phone + verified 2-10 attorneys + completed no-owned-site audit.
- Email is bonus only; strict eligible additionally requires source-verified usable email.
- Do not add Railway services.
- Preserve durable lead/evidence data.
- One callable business phone equals one exported call target.

## Review Focus
- Blank website fields must not qualify without audit completion.
- Legacy email flags must not requeue headcount work.
- Same normalized phone must export once.
- Adapter circuit breaker must reset by adapter version.
- Existing verified 2-10 inventory must be re-audited after deploy.

---

### Task 1: Call-ready contract and audit state
**Files:** modify law-firm-targeting.mjs, strict-owned-website-gate.mjs, pipeline; tests in existing node-test files.
- [ ] Add failing tests proving blank website alone is insufficient and audit-complete no-site is required.
- [ ] Add failing tests for call-ready owned-site audit eligibility.
- [ ] Implement minimal helpers and pipeline state fields.
- [ ] Verify targeted tests and syntax.

### Task 2: Stop legacy recovery churn
**Files:** modify law-lane-pressure.mjs/tests and pipeline.
- [ ] Add failing tests that calling mode never schedules generic legacy recoverable/email conversion work.
- [ ] Remove recoverable/regular/size-ready email queues from normal scheduler.
- [ ] Stop legacy email bootstrap from rebuilding those queues.
- [ ] Preserve opportunistic emails discovered during normal research.
- [ ] Verify targeted tests and syntax.

### Task 3: Re-audit verified 2-10 inventory and route sources
**Files:** add source circuit-breaker helper/tests; modify pipeline.
- [ ] Add failing tests for low-yield source circuit breaker and adapter-version reset.
- [ ] Queue every verified 2-10 callable blank-site record for owned-site audit instead of directly call-ready.
- [ ] Add audit worker that rejects owned sites or marks no-owned-site verified and then adds call-ready.
- [ ] Keep directory-first discovery active and bypass email queue for verified directory candidates.
- [ ] Verify tests and syntax.

### Task 4: Canonical sheet and single writer
**Files:** modify law-sheet-sync.mjs, law-sheet-metrics tests, server.mjs.
- [ ] Add failing regression test for normalized-phone canonical dedupe.
- [ ] Export only audited call-ready rows.
- [ ] Hide stale legacy tabs and archive; keep Call Ready, Strict Eligible, Diagnostics visible.
- [ ] Disable duplicate law-sheet sync ownership in recover-scrape-mcp; law-pipeline is writer.
- [ ] Verify tests and syntax.

### Task 5: Production topology and deploy verification
- [ ] Run full law CI suite on branch/PR.
- [ ] Merge approved branch to recover-scrape-mcp.
- [ ] Verify Railway law-pipeline deployment succeeds.
- [ ] Put acquisition-worker-g and Scrapling into sleep mode; Maps remains sleep-enabled and is not fed while backlog is high.
- [ ] Verify fresh production heartbeat, queue movement, memory, and Google Sheet row count.
- [ ] Report the corrected final call-ready count and all changes.
