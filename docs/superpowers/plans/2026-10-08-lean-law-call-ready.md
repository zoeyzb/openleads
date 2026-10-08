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
- [x] Add failing tests proving blank website alone is insufficient and audit-complete no-site is required.
- [x] Add failing tests for call-ready owned-site audit eligibility.
- [x] Implement minimal helpers and pipeline state fields.
- [x] Verify targeted tests and syntax.

### Task 2: Stop legacy recovery churn
**Files:** modify law-lane-pressure.mjs/tests and pipeline.
- [x] Add failing tests that calling mode never schedules generic legacy recoverable/email conversion work.
- [x] Remove recoverable/regular/size-ready email queues from normal scheduler.
- [x] Stop legacy email bootstrap from rebuilding those queues.
- [x] Preserve opportunistic emails discovered during normal research.
- [x] Verify targeted tests and syntax.

### Task 3: Re-audit verified 2-10 inventory and route sources
**Files:** add source circuit-breaker helper/tests; modify pipeline.
- [x] Add failing tests for low-yield source circuit breaker and adapter-version reset.
- [ ] Queue every verified 2-10 callable blank-site record for owned-site audit instead of directly call-ready.
- [x] Add audit worker that rejects owned sites or marks no-owned-site verified and then adds call-ready.
- [x] Keep directory-first discovery active and bypass email queue for verified directory candidates.
- [ ] Verify tests and syntax.

### Task 4: Canonical sheet and single writer
**Files:** modify law-sheet-sync.mjs, law-sheet-metrics tests, server.mjs.
- [x] Add failing regression test for normalized-phone canonical dedupe.
- [x] Export only audited call-ready rows.
- [x] Hide stale legacy tabs and archive; keep Call Ready, Strict Eligible, Diagnostics visible.
- [x] Disable duplicate law-sheet sync ownership in recover-scrape-mcp; law-pipeline is writer.
- [ ] Verify tests and syntax.

### Task 5: Production topology and deploy verification
- [x] Run full law CI suite on branch/PR.
- [x] Merge approved branch to recover-scrape-mcp.
- [ ] Verify Railway law-pipeline deployment succeeds.
- [x] Put acquisition-worker-g and Scrapling into sleep mode; Maps remains sleep-enabled and is not fed while backlog is high.
- [ ] Verify fresh production heartbeat, queue movement, memory, and Google Sheet row count.
- [ ] Report the corrected final call-ready count and all changes.


## Deployment status — 2026-10-08
- CI: PASS on PR #28, including law targeting, strict no-site gate, lane pressure, sheet metrics, pipeline syntax, sheet/server syntax, and acquisition worker syntax.
- Merge: COMPLETE at commit 415cab8558c4b2a665618c571882650cb55e5fb3 on recover-scrape-mcp.
- Railway service sleep configuration: acquisition-worker-g=true, maps-gosom=true, scrapling=true.
- Production code deployment: BLOCKED by Railway billing/trial state. Railway returned: "Your trial has expired. Please select a plan to continue using Railway."
- Because the new build cannot deploy, production call-ready counts and sheet contents have not yet been re-certified against the new logic.
