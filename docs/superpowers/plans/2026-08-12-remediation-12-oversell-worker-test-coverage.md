# Remediation 12 — Oversell & worker test coverage (M-18 / M-19) — P2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Source audit: `docs/audits/backend-audit-2026-08-12.md` §5 M-18/M-19, §12, §13 Opp-8/Opp-12(extraction half). Evidence re-verified at HEAD `3da7ee0` — with one audit correction: `reserve_pieces` already has exactly **one** pgTAP regression assertion; the gap is its hardening invariants, not "no test at all".

**Goal:** Give the two most safety-critical untested surfaces an executable spec: the `reserve_pieces` oversell guarantee (on its 4th SQL definition with one incidental test) and `worker.ts` (zero tests — including `cancelIntent`'s status mapping, the only guard between the cron and relisting a paid piece).

**Architecture:** (a) A dedicated pgTAP suite for the reserve RPC matrix, riding the existing `supabase/tests/` + `db.yml` CI lane; (b) extract `worker.ts`'s pure decision logic (`cancelIntent` mapping already has a seam via `CancelOutcome`) into `src/lib/` where the vitest globs reach it, plus thin-handler tests. No behaviour changes — pure test/extraction work; any behaviour diff discovered is a finding, not a fix.

**Tech stack:** pgTAP (`supabase test db`), Vitest (note: `vitest.config.ts` includes only `src/**` and `scripts/**` — root `worker.test.ts` would NOT be collected; extraction into `src/` is therefore the mechanism, not config surgery).

## Objective

A future edit that breaks concurrent-reserve safety, expired-takeover, showroom exclusion, or maps `processing → canceled` in `cancelIntent` (which would relist a piece whose payment is settling → oversell) must fail a test, not a customer.

## Findings covered

- **M-18** (MEDIUM) — `worker.ts` zero coverage incl. `cancelIntent` mapping. → PLANNED
- **M-19** (MEDIUM) — `reserve_pieces` hardening invariants untested (corrected scope). → PLANNED
- **Opp-8** (pgTAP CI for reserve) → PLANNED (lane exists; suite is the deliverable)
- **Opp-12** (extraction half) → PLANNED
- **L-8** (residual lock-ordering deadlock window) → **DEFERRED** as a fix; the pgTAP suite documents the sorted-lock behaviour so the residual is at least specified.

## Current-state evidence

All `VERIFIED` at HEAD `3da7ee0`:

- **M-19** — `supabase/tests/private-sale.sql:119-124` holds the single `reserve_pieces` assertion (sold-piece rejection regression). Untested invariants (each added as a fix for a real bug): F8 sorted-`FOR UPDATE` ordering, F7 missing-id folding, F4 idempotent retry, the showroom predicate (added `20260709130000`), expired-reservation takeover, and concurrent-reserve conflict reporting. All suites pass only `p_ttl_secs=900`. Current definition: `20260709130000_showroom_drops.sql:65` (`reserve_pieces`), `20260706120000:68` (`reserve_private_sale_pieces`).
- CI — `.github/workflows/db.yml` runs `supabase db start && supabase test db`, path-filtered to `supabase/**` (+ itself); likely not a required check. New pgTAP files trigger it whenever they change; app-code changes never do (accepted — the RPC SQL only changes via `supabase/**` anyway).
- **M-18** — no `worker.test.*` anywhere; `vitest.config.ts` `include: ['src/**/*.test.ts', 'scripts/**/*.test.ts']` excludes a root-level test. `cancelIntent` mapping is inline in `worker.ts:198-216` (try-cancel → on failure retrieve → `canceled|succeeded|processing|requires_capture → 'paid'` … → `'error'`); the pure consumer `expireAbandonedOrders` lives in `src/lib/expire-orders.ts` (typed `CancelOutcome`, :4-7) and is testable today. Also untested in worker.ts: the DLQ handler body, admin actor-header strip, sweep wiring.
- Plans 02/03 add small extractions of their own (stalled sweep, alert deps) — this plan builds on whatever seams they left.

## Desired end state

- `supabase/tests/reserve_pieces.sql` encodes the full reserve matrix; runs green locally and in `db.yml`.
- `cancelIntent`'s mapping is a pure exported function in `src/lib/expire-orders.ts` (or sibling) with a matrix test; `worker.ts` calls it, keeping only the Stripe I/O inline.
- The DLQ alert-builder and actor-strip logic have unit tests via extraction or existing seams.

## Scope

- New `supabase/tests/reserve_pieces.sql`
- `src/lib/expire-orders.ts` (+ test) — receive the extracted mapping
- `worker.ts` — mechanical extraction edits only (no behaviour change; assert via the new tests mirroring the current mapping exactly)
- Optionally `src/server/fulfilment/dlq.ts`-adjacent tests if a seam already exists (`dlq.test.ts` exists — extend rather than create)

## Out of scope

- Changing any RPC SQL (Plan 07 owns the TTL clamp; if Plan 07 landed, the suite asserts the clamp too — coordinate).
- Changing `cancelIntent` semantics (the mapping is copied verbatim; a deliberate `requires_capture` reconsideration is a separate discussion).
- Making `db.yml` a required check — recommend it to the operator in the PR description (repo-settings change, operator action), not a file change.
- E2E coverage growth.

## Implementation steps

### Task 1 — pgTAP reserve matrix (M-19)

- [ ] Write `supabase/tests/reserve_pieces.sql` (pattern of `private-sale.sql`: `begin; select plan(N); … fixtures … assertions … select * from finish(); rollback;`), asserting at minimum:
  1. Reserving two available pieces succeeds (empty conflict array) and stamps `reserved_until ≈ now()+900s`, `order_id`.
  2. A second order reserving an overlapping set returns exactly the conflicting ids and mutates nothing.
  3. Idempotent retry: the same order re-reserving its own set succeeds without extending/duplicating (per F4 semantics — read the function body's comments for the exact contract and assert that).
  4. Expired takeover: a `reserved` row with `reserved_until < now()` is claimable by a new order.
  5. `sold` rejection (exists in private-sale.sql — keep both; this suite owns it going forward).
  6. `showroom = true` pieces are rejected/excluded (assert the actual predicate behaviour from `20260709130000`).
  7. Missing ids are folded into the conflict/result per F7's contract.
  8. Determinism under sorted locking: reserve `array['b','a']` — succeeds identically to `['a','b']` (behavioural proxy for the F8 ordering; true concurrency isn't testable in pgTAP — note this limit in the header comment).
  9. If Plan 07 landed: `p_ttl_secs` of `-5` and `999999` clamp into `[60, 3600]`.
- [ ] `supabase db start && supabase test db` locally — green (paste plan/finish output).
- [ ] Commit: `test(db): pgTAP matrix for reserve_pieces oversell invariants (M-19)`

### Task 2 — extract + matrix-test `cancelIntent` (M-18 core)

- [ ] Failing test first in `src/lib/expire-orders.test.ts` (create/extend): a pure `mapCancelAttempt(result: { cancelled: true } | { retrievedStatus: string } | { unreachable: true }): CancelOutcome` matrix:
  - cancel success → `'canceled'`;
  - retrieve `canceled` → `'canceled'`; `succeeded`/`processing`/`requires_capture` → `'paid'`; anything else → `'error'`;
  - retrieve throws → `'error'`.
  Include the regression case the audit names: `processing` must NEVER map to `'canceled'` (comment why: relisting during settlement = oversell).
- [ ] Extract the mapping from `worker.ts:198-216` into that pure function; `worker.ts`'s `cancelIntent` becomes Stripe calls + `mapCancelAttempt`. Verbatim semantics — the test matrix is written from the current code, not from opinion.
- [ ] `npx vitest run src/lib/expire-orders*` + `npm run typecheck` — green.
- [ ] Commit: `test(worker): extract cancelIntent status mapping into a matrix-tested pure function (M-18)`

### Task 3 — remaining worker seams (M-18 rest)

- [ ] Inventory what Plans 02/03 already extracted (stalled sweep, alert deps). For each remaining inline decision block in `worker.ts` — DLQ alert construction, admin actor-header strip — extend the existing unit suites (`dlq.test.ts`, access tests) if the logic already lives in `src/`; extract only where it doesn't, with the same mechanical-move discipline.
- [ ] Do NOT attempt to unit-test the raw `queue()`/`scheduled()` export wiring — the preview rehearsal (Plan 05) is its integration test; state this boundary in a `worker.ts` header comment so future coverage work doesn't re-litigate it.
- [ ] `npm test` — green.
- [ ] Commit: `test(worker): cover DLQ alert + actor-strip decision logic (M-18)`

## Database / migration work

None (tests only; the pgTAP file is not a migration).

## External-system changes

None. (Recommendation to the operator, recorded in the PR: make `db.yml` a required status check on `main` — GitHub settings, not a file.)

## Tests

This plan **is** tests. Regressions caught: any future weakening of reservation invariants via `supabase/**` edits; any `cancelIntent` mapping drift; DLQ alert regressions.

## Verification

- **Local:** `supabase test db` full output pasted (all suites incl. the new one); `npm test` pasted.
- **CI:** the PR touching `supabase/tests/**` triggers `db.yml` — link the green run.
- No preview/live steps (no behaviour change).

## Rollout / recovery

Pure test/extraction PR. **Stop signal:** any extracted function's test failing against the verbatim copy means the extraction changed behaviour — halt and re-diff rather than "fixing" the test.

## Acceptance criteria

- [ ] `reserve_pieces.sql` ≥ 9 assertions green locally and in CI.
- [ ] `mapCancelAttempt` matrix green, incl. the `processing → 'paid'` (never `'canceled'`) case.
- [ ] `worker.ts` contains no untested *decision* logic (I/O wiring exempt, documented).
- [ ] Full `npm test` + `supabase test db` green.

## Dependencies

- Soft: Plans 02/03 (their extractions land first to avoid conflicts in `worker.ts`); Plan 07 (adds the TTL-clamp assertion when present). None blocking.

## Risks / unresolved questions

- pgTAP cannot exercise true concurrency — the suite specifies single-session behaviour; the concurrent guarantee remains proven by the (audit-verified) sorted-lock design + this suite's determinism proxy. If stronger assurance is ever wanted, a two-connection test script under `scripts/` would be the follow-up (backlog).
