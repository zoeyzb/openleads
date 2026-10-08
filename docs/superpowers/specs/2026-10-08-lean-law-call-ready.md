# Lean Law Call-Ready Pipeline Design

## Goal
Make the production law pipeline optimize for one calling KPI: a law firm with a usable public phone, source-verified 2-10 attorney headcount, and a completed no-owned-website audit. Email is bonus evidence only and never blocks call readiness.

## Constraints
- Preserve existing qualified lead inventory and durable evidence.
- Do not add Railway services.
- Keep normal production topology small: law-pipeline, Redis, recover-scrape-mcp; Maps/acquisition/Scrapling may sleep when not needed.
- Never count a blank website field as proof of no owned website.
- Never count duplicate attorney listings sharing the same normalized business phone as separate call targets.
- Source-verified usable email remains the strict-eligible bonus subset.
- Existing headcount evidence must remain source-verified; do not loosen the 2-10 gate.

## State flow
Discovered -> usable phone -> verified law firm -> verified 2-10 -> owned-site audit -> call-ready.
Wrong-size, known-site, and bad-phone records leave the call-ready path.
Unresolved headcount records may retry only through explicit method/version states; legacy email recovery state must not recycle them.

## Work scheduling
- Main enrichment capacity is reserved for phone/headcount and call-ready website audit.
- Generic legacy email/recoverable queues are not scheduled in the calling critical path.
- Directory/source-first discovery remains active because it can publish firm size directly.
- Generic Maps acquisition pauses while unresolved callable inventory is above threshold.
- Email found on pages already read is retained; no dedicated email-recovery worker is required for call readiness.

## Source routing
- Low-yield direct bar adapters circuit-break after a meaningful sample when profile-link yield is below threshold.
- Circuit breakers are per adapter version so a fixed adapter can be retried.
- Scrapling is last-resort only after direct/Jina paths and should not be required for routine qualification.

## Sheet
- Call Ready is the primary visible tab.
- Strict Eligible is the email-bonus subset.
- Diagnostics contains current operational counts only.
- Lead Archive remains durable but hidden.
- Legacy/stale metric tabs are hidden.
- Call Ready deduplicates on normalized phone so one callable business line is one row.
- One production process owns law sheet sync.

## Success criteria
1. Legacy recoverable backlog no longer drives repeated headcount work.
2. Call-ready rows require completed no-owned-site verification.
3. Existing verified 2-10 candidates are re-audited into the corrected call-ready set.
4. Sheet row count equals canonical exported call-ready businesses.
5. Low-yield adapters and raw Maps acquisition stop consuming normal capacity when unproductive.
6. CI regression tests pass and production heartbeat/sheet reflect the corrected KPI.
