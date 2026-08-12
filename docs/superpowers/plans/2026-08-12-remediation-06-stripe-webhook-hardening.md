# Remediation 06 — Stripe webhook handler hardening (H-1 / M-5 / M-21 / M-22 / M-27 / L-4 / L-5 / L-6 / L-7) — P1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Source audit: `docs/audits/backend-audit-2026-08-12.md` §5 (Stripe group). Evidence re-verified at HEAD `3da7ee0`. Land **after** Plan 01 (same files; keep diffs separable).

**Goal:** Close the narrow-but-real failure windows inside the webhook route: the one unchecked money-path UPDATE, the private-sale double-payment 5xx loop, two idempotency-ledger drop windows, the un-CAS'd lease release, missing dispute/invoice/post-processing alerts, and unprotected email retries.

**Architecture:** All changes live in `src/app/api/stripe/webhook/route.ts`, `src/lib/webhook.ts`, and `src/lib/email.ts`, following the file's own established patterns (destructure-and-throw, CAS predicates, claim-once + `waitUntil`). No new abstractions; each fix is a few lines plus tests.

**Tech stack:** Existing webhook route (~49 tests in `route.test.ts`), Resend REST (`Idempotency-Key` header per https://resend.com/docs/dashboard/emails/idempotency-keys).

## Objective

Eliminate silent-drop and wrong-outcome windows on the paid path:
- H-1: an asymmetric transient DB failure currently auto-refunds a legitimate payment and strands pieces `reserved`, returning 200 (no retry).
- M-5: a double-paid private-sale link turns `markPaid` into a permanent 5xx loop with captured money and no refund.
- M-21/M-22: ledger error-swallow and in-flight-lease semantics can permanently drop a retryable event.
- L-4: lease release/done not scoped to the claim, so a stale worker can clobber a newer claim's state.
- L-5/L-6/L-7: invoice failures, `charge.dispute.created`, and post-processing failures are silent or console-only.
- M-27: email sends retry without provider-side idempotency → double-send window.

## Findings covered

- **H-1** (MEDIUM, first-pass HIGH) → PLANNED
- **M-5** (MEDIUM `[INFERENCE]`) → PLANNED
- **M-21** (MEDIUM) → PLANNED
- **M-22** (MEDIUM `[INFERENCE]`) → PLANNED
- **M-27** (MEDIUM) → PLANNED
- **L-4** (LOW) → PLANNED (same file/failure family)
- **L-5** (LOW) → PLANNED (alert only; invoice retry/backfill machinery stays deferred)
- **L-6** (LOW) → PLANNED (the `charge.dispute.created` alert branch; trimming the other subscribed no-op events remains the operator option noted in Plan 01)
- **L-7** (LOW) → PLANNED
- **M-20** (MEDIUM, ack-fast rearchitecture) → **DEFERRED** — moving all fulfilment work behind a queue is a money-path rearchitecture; at current volume the 3-day Stripe retry window plus this plan's error-handling fixes bound the risk. Revisit if Stripe delivery latency alarms fire or volume grows.

## Current-state evidence

All `VERIFIED` at HEAD `3da7ee0` in `src/app/api/stripe/webhook/route.ts` unless noted:

- **H-1** `:275-279` — `await supabase.from('piece_state').update({ status: 'sold', reserved_until: null }).eq('order_id', orderId).eq('status', 'reserved');` — result not destructured; uniquely unchecked (the neighbouring statements `:281-295` destructure and throw). The under-fulfilment auto-refund lives at `:297-319` and keys off a separate COUNT.
- **M-5** `:208-218` — pending→paid CAS destructures `{ error: orderErr }` typed as `{ message: string }` (no `code` field) → any error, including `23505` from `private_sales_one_paid_order`, becomes an unconditional throw → 5xx → 3-day Stripe retry loop; no `refund_<pi>` fallback.
- **M-21** `:144-150` — `const { data: seen } = await supabase.from('webhook_events').select(…)` — error dropped; a failed lookup falls into the insert branch, and a `23505` there returns `{ received: true, deduped: true }` (:187) — i.e. a transient SELECT failure racing an existing non-`done` row yields a false dedupe-200.
- **M-22** `:155-162` — active lease (< `STRIPE_LEASE_MS` = 5 min, :142) → `{ received: true, deduped: true }` 200. Isolate death inside the lease permanently drops the event (Stripe got its 200).
- **L-4** `:198-204` (releaseLease → `status:'failed'`) and `:796-800` (done-write) — both scoped only by `(provider, provider_event_id)`, not by the `processing_started_at` claim timestamp; the claim CAS itself (:165-173) IS properly scoped.
- **L-5** `:575-582` — `ensureInvoiced` catch: `console.error` + `Sentry.captureException`, never rethrown, no retry/backfill; `reconcile-orders --invoices` is report-only.
- **L-6** `src/lib/webhook.ts:89-90` — `charge.dispute.created` (subscribed live per audit) falls into `default: return` after a full `raw_json` ledger row is written; no alert → dispute-response deadline risk.
- **L-7** — `markPaid` post-processing failures (order/items load for emails/conversions) are console-only in their catch (locate exact lines during implementation; audit L-7).
- **M-27** `src/lib/email.ts:71-79` (`sendResendTemplate`) and `:108-113` (`sendResendHtml`) — plain fetch, no `Idempotency-Key` (grep = 0 hits in `src/`); `sendEmailOnceWithClaim` (:40-107 of the route) retries the send up to 3× after claiming — a Resend timeout + retry can double-send.
- Test harness `VERIFIED`: `route.test.ts` mocks via mutable closures (`supabaseImpl`, `weChain()` ledger builders, `deferred[]` waitUntil collector) — all fixtures needed for the new tests already exist.

## Desired end state

Every mutation on the paid path either succeeds, throws (→ Stripe retry), or produces a deliberate alert; no path returns 200 while dropping work it should have done; duplicate email sends are provider-deduped; disputes alert on creation.

## Scope

- `src/app/api/stripe/webhook/route.ts`
- `src/lib/webhook.ts` (dispute-created branch + deps)
- `src/lib/email.ts` (+ its direct callers for the idempotency key parameter)
- `src/app/api/stripe/webhook/route.test.ts`, `src/lib/webhook.test.ts`, email tests

## Out of scope

- `releaseSale` logic, `HANDLED_STRIPE_EVENTS`, refund events (Plan 01).
- Queue/ack-fast rearchitecture (M-20 — deferred, above).
- The ledger's schema (retention is Plan 14; the `webhook_events` table itself is untouched).
- InPost/Prodigi legs called from `markPaid` (their own plans).

## Implementation steps

Order: each fix = failing test → minimal change → green → commit. All tests use the existing `route.test.ts` fixtures.

### Task 1 — H-1: check the reserved→sold UPDATE

- [ ] Failing test: `payment_intent.succeeded` where the `piece_state` sold-UPDATE returns `{ error }` while the follow-up COUNT succeeds → expect the route to **throw/5xx** (Stripe will retry) and `refunds.create` NOT called.
- [ ] Fix `:275-279`: destructure `{ error: soldErr }` and `if (soldErr) throw new Error(\`markPaid piece_state sold update failed: ${soldErr.message}\`);` — mirroring the file's own pattern at `:281-295`.
- [ ] Green + commit: `fix(webhook): throw on reserved→sold update failure instead of auto-refunding (H-1)`

### Task 2 — M-5: catch the private-sale unique violation

- [ ] Failing test: second `payment_intent.succeeded` for a different order on the same private sale → the CAS UPDATE rejects with `{ code: '23505', message: … }` → expect: order CAS'd to `failed` (or left `pending` — decide with the simplest correct semantics below), `refunds.create` called once with idempotency key `refund_<pi>`, response 200 (no retry loop), studio alert fired.
- [ ] Fix: widen the error narrowing at `:208-218` to include `code?: string`; on `23505`: (a) `refunds.create({ payment_intent: pi }, { idempotencyKey: `refund_${pi}` })`; (b) CAS the order `pending→failed`; (c) studio email + `Sentry.captureMessage('private_sale_double_paid')`; (d) return normally (200). Any other error keeps the unconditional throw.
- [ ] Note: `refund_<pi>` matches the file's existing refund idempotency-key convention (verify the exact constant used by the under-fulfilment path at `:297-319` and reuse it).
- [ ] Green + commit: `fix(webhook): refund + fail instead of 5xx-looping on double-paid private sale (M-5)`

### Task 3 — M-21 + M-22 + L-4: ledger correctness

- [ ] Failing tests:
  - seen-SELECT returns `{ error }` → route throws (5xx), no dedupe-200;
  - an event with an **active** lease → response is **non-2xx** (409 preferred) so Stripe redelivers after the lease, instead of dedupe-200;
  - `releaseLease`/done-write include `.eq('processing_started_at', <claimedAt>)` — a stale releaser (mismatched claim) writes nothing (assert the builder chain got the extra `.eq`).
- [ ] Fixes:
  - `:144-150` destructure `{ data: seen, error: seenErr }`; throw on `seenErr`.
  - `:155-162` change the active-lease branch to `return NextResponse.json({ received: false, inFlight: true }, { status: 409 })` — reserve dedupe-200 for `status='done'` rows only. (Stripe treats any non-2xx as retry-later; document this in a comment.)
  - `:198-204` and `:796-800` add `.eq('processing_started_at', claimedAtIso)` to both writes (the claim timestamp is already known at both call sites — thread it if needed).
- [ ] Check the ~49 existing route tests: the M-22 semantic change will flip any test asserting dedupe-200 during a lease — update those assertions deliberately (they encode the old, droppy behaviour).
- [ ] Green + commit: `fix(webhook): harden the idempotency ledger (seen-error throw, 409 on active lease, claim-scoped release) (M-21, M-22, L-4)`

### Task 4 — L-6: dispute-created alert branch

- [ ] Failing test in `src/lib/webhook.test.ts`: `charge.dispute.created` calls a new `deps.alertDisputeCreated(dispute)` once.
- [ ] Add the branch in `src/lib/webhook.ts` (before `default`), add `charge.dispute.created` to `HANDLED_STRIPE_EVENTS` (Plan 01's constant — the drift guard then requires it subscribed; it already is, live). Implement the dep in the route: studio email (deadline-bearing: include `evidence_details.due_by`) + `Sentry.captureMessage('stripe_dispute_created', { level: 'error' })`.
- [ ] Green + commit: `feat(webhook): alert on charge.dispute.created (L-6)`

### Task 5 — L-5 + L-7: stop the silent catches

- [ ] `ensureInvoiced` catch (`:575-582`): keep the swallow (Stripe must still get 200 — invoicing is best-effort by design) but add the studio-alert email alongside the existing Sentry capture, so a failed invoice is operator-visible the day it happens. Test: invoice failure → alert dep called, response still 200.
- [ ] `markPaid` post-processing catch(es) (L-7): upgrade `console.error`-only catches to also `Sentry.captureException` (locate by grepping the function for bare `console.error` catches). Test where the fixture allows it cheaply.
- [ ] Green + commit: `fix(webhook): surface invoice/post-processing failures to Sentry + studio (L-5, L-7)`

### Task 6 — M-27: Resend idempotency keys

- [ ] Add an optional `idempotencyKey?: string` to `sendResendTemplate` / `sendResendHtml` params in `src/lib/email.ts`; when present, send header `'Idempotency-Key': idempotencyKey` (Resend dedupes for 24 h).
- [ ] Thread keys from the claim-based senders: use the claim identity, e.g. `order-confirmation/<orderId>`, `studio-new-order/<orderId>` — the same key on a retry after timeout makes the retry safe.
- [ ] Failing test first: the fetch mock asserts the header is present with the expected key for the order-confirmation path; absent when no key passed.
- [ ] Green + commit: `fix(email): Idempotency-Key on Resend sends so claim-retry can't double-send (M-27)`

## Database / migration work

None. (L-4's claim-scoping uses the existing `processing_started_at` column.)

## External-system changes

None. (Resend `Idempotency-Key` is a request header, no dashboard config. The dispute alert requires `charge.dispute.created` to be subscribed — it already is, per the audit's live endpoint listing; the Plan 01 drift guard will enforce it.)

## Tests

- **Modified:** route tests asserting dedupe-200 during an active lease (now 409); any snapshot of the deps object shape.
- **New:** the six failing-first tests above; plus one integration-style test that a full `payment_intent.succeeded` happy path still returns 200 with all claims stamped (regression net for the semantic changes).
- **Failure modes simulated:** asymmetric piece_state write failure; `23505` on the order CAS; ledger SELECT failure; concurrent delivery during a lease; stale lease release; Resend timeout + retry.

## Verification

- **Local/unit:** `npx vitest run src/app/api/stripe/webhook/route.test.ts src/lib/webhook.test.ts` — paste the run (expect the full suite, ~55+ tests, green). `npm run lint && npm run typecheck && npm test`.
- **Preview:** drive one test-mode checkout through the preview webhook (can piggyback Plan 05's rehearsal) — confirm 200 + all rows/claims correct with the new code.
- **Live read-only:** after deploy, watch the Stripe delivery log for the first real deliveries — all 2xx (or expected 409-then-2xx pairs under concurrent redelivery).
- **Live mutation:** none.

## Rollout / recovery

1. Single PR (`fix:`), after Plan 01 merges (shared files).
2. The M-22 change (409 on active lease) alters Stripe-visible behaviour: concurrent duplicate deliveries now show as failed attempts that later succeed. Note this in the PR so nobody "fixes" the 409s back.
3. **Rollback:** revert the PR; all changes are stateless code paths, nothing to unwind.
4. **Stop signals:** sustained 409s for the *same* event beyond the 5-min lease (indicates a stuck lease — investigate before assuming Stripe's fault); any refund created by the M-5 path (should be near-impossible; each one deserves a manual review).

## Acceptance criteria

- [ ] All six task-level tests green; full webhook suite green (pasted).
- [ ] A simulated asymmetric failure no longer auto-refunds; a simulated double-paid private sale refunds exactly once and returns 200.
- [ ] Active-lease redelivery returns 409; `done` rows still dedupe-200.
- [ ] `charge.dispute.created` produces a deadline-bearing alert.
- [ ] Resend requests carry `Idempotency-Key` on claim-based sends.
- [ ] One preview test-mode checkout passes end-to-end on the new code.

## Dependencies

- **Plan 01** first (same files: `webhook.ts` constant + deps object). Plan 05's rehearsal is the convenient preview vehicle but not a hard dependency.

## Risks / unresolved questions

- M-22's 409 semantics: if a handler legitimately runs longer than 5 min (it shouldn't — Stripe's own timeout is shorter), the event redelivers and 409s until the lease expires; the lease TTL (`STRIPE_LEASE_MS`) may deserve tuning down to ~2 min in the same change — decide from the p99 handler duration visible in Workers logs.
- M-5's "order → `failed`" choice: verify no downstream consumer treats `failed` + captured-money as impossible; if so, prefer leaving `pending` + alert. Decide during implementation with a grep for `status = 'failed'` consumers.
