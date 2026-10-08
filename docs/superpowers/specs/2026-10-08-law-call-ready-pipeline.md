# Law Call-Ready Pipeline Repair Spec

## Goal

Make the production law lead pipeline optimize for one primary business result: a **call-ready law firm** with a usable phone, verified 2-10 attorney headcount, and verified absence of an owned website. Email remains optional bonus enrichment and must never block call-ready qualification.

## Production constraints

- Keep Railway topology small. The normal path is `law-pipeline` + Redis + the lightweight MCP/control service.
- `acquisition-worker-g`, `maps-gosom`, and Scrapling must stay dormant unless the existing inventory cannot supply useful work or an explicit fallback is justified.
- Do not add new long-lived Railway services.
- Preserve existing strict source-validation rules for attorney counts.
- Preserve source-verified email evidence when it is encountered for free during research.
- Do not reintroduce email as a qualification gate for the calling list.
- The Google Sheet's headline number must equal canonical exported call-ready firms, not a raw Redis set cardinality.

## Qualification state

A lead can enter Call Ready only when all are true:

1. Law-firm identity is valid.
2. Phone is usable.
3. Attorney count evidence is verified and count is between 2 and 10 inclusive.
4. A forced owned-website audit has completed for the current audit version.
5. That audit did not find an owned website.

If a trusted source or forced audit finds an owned website, remove the lead from call-ready immediately.

Email does not affect Call Ready. If a source-verified usable email is encountered while doing the above work, retain it and flag it as a bonus.

## Queue behavior

- General phone/headcount workers may not recycle records because of legacy email recovery flags.
- Existing unresolved callable inventory gets a bounded retry budget per headcount-method version instead of permanent exclusion after one failed pass.
- Work selection must have a real disposition: success, wrong size, owned website, retry with next headcount attempt, or cooldown/exhausted. The same item must not be immediately reselected forever.
- Generic email recovery is removed from the general worker's critical path.
- Generic Maps discovery pauses while unresolved callable inventory is above the configured threshold.
- Source-first directory discovery remains active even while Maps discovery is paused.

## Source controls

- Low-yield state-bar adapters must be suppressible with a circuit-breaker policy based on recent attempts and useful profile discoveries.
- Scrapling is fallback-only. Direct fetch and Jina are preferred.
- Jina response caching is bounded by approximate bytes, not only item count.

## Canonicalization and sheet

- Dedupe call-ready firms by normalized phone first, then by normalized firm identity/address where phone is absent.
- Do not count multiple attorney/person listings sharing one business phone/address as separate call-ready firms.
- Visible workbook tabs should be reduced to Call Ready, Strict Eligible, and Diagnostics. Archive may remain hidden for durability.
- Strict Eligible is the call-ready subset that also has a source-verified usable email.
- Only one production service should own the law-sheet writer.

## Verification

Success requires all of the following:
- regression tests covering queue recycle, headcount retry, call-ready website-audit requirement, canonical firm dedupe, source circuit breaker, and discovery pause;
- full law-pipeline CI green;
- production deployment healthy;
- live logs showing the generic recoverable/email loop no longer dominating batches;
- sheet count reconciled to canonical exported call-ready rows.