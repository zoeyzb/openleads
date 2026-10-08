# Law Call-Ready Pipeline Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the law pipeline so production work converges on canonical call-ready law firms instead of recycling email-era work.

**Architecture:** Keep one law qualification service. Move qualification state into small testable policy helpers, make owned-site verification an explicit call-ready gate, bound retries and source usage, and make the sheet consume canonical call-ready records.

**Tech Stack:** Node.js 22, Redis, Railway, Google Sheets API, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-08-law-call-ready-pipeline.md`

## Global Constraints

- Call Ready requires law + usable phone + verified 2-10 attorneys + completed no-owned-website audit.
- Email is bonus-only for the calling path.
- No new long-lived Railway services.
- Preserve strict headcount evidence rules.
- Existing inventory is preferred over duplicate Maps discovery.

## Review Focus

- A stale `law_email_validation=recovery_pending` value must never requeue a general phone/headcount lead.
- One failed headcount pass must not permanently exclude a lead from the new method-version retry budget.
- Empty `website` without a completed current audit must not qualify.
- Two records with the same normalized business phone must export as one firm.
- A zero-yield source must trip the circuit breaker while a productive source remains enabled.

---

### Task 1: Call-ready policy and queue convergence

**Files:** Create `recover-mcp/law-call-ready-policy.mjs`, create its node test, modify `law-firm-pipeline.mjs`, modify workflow.

- [ ] Write failing tests for website-audit gate, retry budget, and legacy email non-recycle.
- [ ] Run CI/test and observe expected failure.
- [ ] Implement helper and wire pipeline queue disposition to it.
- [ ] Re-run tests and syntax checks.

### Task 2: Website audit gate and directory-first promotion

**Files:** Modify `law-firm-pipeline.mjs`, `strict-owned-website-gate.mjs`, and its test.

- [ ] Add failing tests proving email is not required to trigger final owned-site audit.
- [ ] Run tests red.
- [ ] Force owned-site preflight after verified 2-10 + phone; persist audit version/status; promote only after audit miss.
- [ ] Remove directory seeds from email conversion as mandatory next step.
- [ ] Start relevant audit loop and verify tests green.

### Task 3: Source circuit breakers, fallback policy, and memory bound

**Files:** Create `law-source-circuit.mjs` plus test; modify pipeline and workflow.

- [ ] Write failing tests for dead vs productive source behavior.
- [ ] Run red.
- [ ] Gate low-yield state-bar adapters; keep productive paths available.
- [ ] Disable Scrapling on broad/default research and keep fallback-only.
- [ ] Add approximate-byte cap to Jina cache.
- [ ] Run green.

### Task 4: Discovery pause and service simplification

**Files:** Create `law-discovery-policy.mjs` plus test; modify pipeline and workflow.

- [ ] Write failing test proving generic Maps pauses while unresolved callable inventory is large.
- [ ] Run red.
- [ ] Wire policy into generic seed loop while leaving directory-first loop active.
- [ ] Run green.
- [ ] Stage Railway service sleep/resource changes for acquisition, Maps, and Scrapling.

### Task 5: Canonical sheet export and simplified workbook

**Files:** Create `law-firm-identity.mjs` plus test; modify `law-sheet-sync.mjs`, `server.mjs`, and workflow.

- [ ] Write failing tests for same-phone duplicate collapse.
- [ ] Run red.
- [ ] Deduplicate by canonical firm identity.
- [ ] Make one production service the sheet owner.
- [ ] Reduce visible sheet surface to Call Ready, Strict Eligible, Diagnostics; keep Archive hidden.
- [ ] Run green.

### Task 6: Whole-system verification and production rollout

- [ ] Run full law-pipeline CI and syntax suite.
- [ ] Review diff against spec.
- [ ] Merge feature branch into `recover-scrape-mcp`.
- [ ] Deploy/redeploy affected Railway services.
- [ ] Confirm Railway health and memory.
- [ ] Inspect live batches and final call-ready count.
- [ ] Reconcile sheet rows, canonical firms, and Redis call-ready count.