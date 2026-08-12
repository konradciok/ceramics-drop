# Remediation 06 — Stripe webhook handler hardening (H-1 / M-5 / M-21 / M-22 / M-27 / L-4 / L-5 / L-6 / L-7) — P1

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Source audit: `docs/audits/backend-audit-2026-08-12.md` §5 (Stripe group). Evidence re-verified at HEAD `3da7ee0`. Land **after** Plan 01 (same files; keep diffs separable).

**Goal:** Close the narrow-but-real failure windows inside the webhook route: the one unchecked money-path UPDATE, the private-sale double-payment 5xx loop, two idempotency-ledger drop windows, the un-CAS'd lease release, missing dispute/invoice/post-processing alerts, and unprotected email retries.

**Architecture:** Most changes live in `src/app/api/stripe/webhook/route.ts`, `src/lib/webhook.ts`, and `src/lib/email.ts`, following the file's own established patterns (destructure-and-throw, CAS predicates). **Task 2's `failed`-state contract additionally touches `src/lib/account/status.ts`** (the `customerOrderStatus` fix) and adds regression coverage across the `failed`-status consumers (account list/detail, admin fulfilment, print worker, conversions) — so this is not strictly a three-file change. No new abstractions; each fix is a few lines plus tests.

**Do not change the email-send concurrency model.** `sendEmailOnceWithClaim` is intentionally **awaited inline** in the webhook handler so the "sent" claim is recorded only *after* the send completes — if the send were moved into `ctx.waitUntil`, the webhook could return `200` with the claim already written and Stripe would not redeliver after an isolate termination, silently losing the email. The M-27 fix (Task 6) adds a Resend `Idempotency-Key` for retry safety; it does **not** move the send off the inline path. `ctx.waitUntil` remains reserved for the conversions dispatch, not for claim-based emails.

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
- `src/lib/account/status.ts` (Task 2 — `customerOrderStatus` fix for a `failed` order)
- `src/app/api/stripe/webhook/route.test.ts`, `src/lib/webhook.test.ts`, email tests, and consumer regression tests (account/fulfilment/worker/conversions `failed`-state)

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

**State machine (decided — implement exactly this, do not leave it open):** on a `23505` from the second order's `pending→paid` CAS, the terminal state is **`failed`**, never left `pending`. Rationale: a `pending` order is eligible for the abandoned-checkout cron (cancel PI + expire) and other pending flows, and non-`paid` orders are excluded from fulfilment — a captured-but-refunded double-payment left `pending` would be acted on incorrectly by those flows. Ordering, crash-safety, and idempotency:
  1. **Mark the order refund-pending *before* calling Stripe** — set a durable marker (a new nullable `orders.refund_pending_at timestamptz`, tiny additive migration) CAS'd `where payment_intent_id=$pi and status='pending'`. This closes the crash window: if the isolate dies *after* `refunds.create` but *before* the `pending→failed` CAS, the order is still `pending` — the marker is what keeps the abandoned-checkout cron and other pending consumers from acting on a payment that is being refunded. **Pending consumers must exclude `refund_pending_at IS NOT NULL`** (extend the cron/expiry query — coordinate with Plan 03's cron sweep). Stripe's retry re-runs the handler and the refund idempotency key makes the second `refunds.create` a no-op, then the CAS completes.
  2. **Refund:** `refunds.create({ payment_intent: pi }, { idempotencyKey: <the file's refund key, e.g. `refund_${pi}`> })` — the key makes a crash-retry a no-op at Stripe (already-refunded attempts return the same refund, not a double refund).
  3. **CAS `pending→failed`** (`update orders set status='failed', refund_pending_at=null … where payment_intent_id=$pi and status='pending'`). On **zero rows**, do **not** blindly 200 — perform a **follow-up lookup** of the order and only ack 200 when it is in a documented safe state (already `failed`, or already `refunded`). If the order is **missing** or in an **unexpected** status, throw (→ Stripe retry) rather than acknowledging — a blanket zero-row=success masks a genuinely lost order. A CAS **error** (not zero-row) still propagates.
  4. Fire the studio email + `Sentry.captureMessage('private_sale_double_paid', { level: 'error' })`.
  5. Return **200** only after the refund and the state transition have both succeeded (or the follow-up lookup confirmed a safe terminal state). Any error **other than** `23505` on the original CAS keeps the existing unconditional throw.

- [ ] Failing tests: (a) second `payment_intent.succeeded` for a different order on the same private sale → `refund_pending_at` set before `refunds.create`, refund called once with the file's key, order ends `failed` with `refund_pending_at` cleared, response 200, studio alert fired; (b) redelivery after the order is already `failed` → CAS zero rows → follow-up lookup finds `failed` → 200, refund not re-created (idempotency key), no throw; (c) **crash after `refunds.create`, before the CAS** → order still `pending` **with `refund_pending_at` set** → the abandoned-checkout cron **skips** it (regression test on the pending-consumer query); (d) CAS zero rows + follow-up finds the order **missing or in an unexpected status** → **throw** (5xx), not a silent 200; (e) a non-`23505` error on the CAS → still throws.
- [ ] Fix: widen the error narrowing at `:208-218` to include `code?: string`; implement the state machine above. Confirm the exact refund idempotency-key constant by reading the under-fulfilment path at `:297-319` and reuse it verbatim.
- [ ] **`failed`-consumer audit (a required Task 2 gate, not an open question).** Verify every consumer of `orders.status` handles a `failed` row that represents a *captured-then-refunded* payment correctly:
  - Account list/detail (`src/lib/account/orders.ts`) already filter to `['paid','refunded']` — a `failed` order is correctly excluded (confirm).
  - Admin fulfilment (`src/lib/admin/fulfillment.ts`) and the print worker require `status === 'paid'` — `failed` is correctly excluded (confirm).
  - Server conversions (`src/lib/marketing/conversions.ts`) return unless `paid` — correct (confirm).
  - **`customerOrderStatus` (`src/lib/account/status.ts`) does NOT special-case `failed`** and would map a direct `failed` input to a normal delivery state — **fix it** so a `failed` order surfaces a non-delivery status (or is excluded), and add a regression test. This is the one consumer that needs a code change.
- [ ] Regression tests for the contract: a captured-but-refunded `failed` order triggers **no** fulfilment and **no** pending/abandoned-cron action, is **absent** from account lists, and `customerOrderStatus` does not render it as a normal delivery state.
- [ ] Green + commit: `fix(webhook): refund-then-fail state machine + failed-state consumer contract (M-5)`

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
- [ ] `markPaid` post-processing catch(es) (L-7): **first enumerate every `console.error`-only catch** in the post-processing path (grep the function for bare `console.error` catches and list them explicitly in the PR). Upgrade **each** to also `Sentry.captureException`, and add **one regression test per enumerated catch** (not a vague "≥2") so the gate cannot pass with one silent catch left un-upgraded. If a catch is deliberately left console-only, list it as an explicit exception with a reason.
- [ ] Green + commit: `fix(webhook): surface invoice/post-processing failures to Sentry + studio (L-5, L-7)`

### Task 6 — M-27: Resend idempotency keys

- [ ] Add an optional `idempotencyKey?: string` to `sendResendTemplate` **and** `sendResendHtml` params in `src/lib/email.ts`; when present, send header `'Idempotency-Key': idempotencyKey` (Resend dedupes for 24 h).
- [ ] Thread keys from **every** claim-based sender: `order-confirmation/<orderId>` (customer, `sendResendTemplate`) **and** `studio-new-order/<orderId>` (studio, `sendResendHtml`) — the same key on a retry after timeout makes the retry safe.
- [ ] Failing tests first — **cover both helpers and both senders**: assert `sendResendTemplate` sends `Idempotency-Key: order-confirmation/<orderId>` and `sendResendHtml` sends `Idempotency-Key: studio-new-order/<orderId>` when a claim is present, and that each omits the header when no key is passed.
- [ ] **Residual duplicate-send window (document + accept — MCP-flagged):** Resend's `Idempotency-Key` dedupes for only **24 h**, while Stripe retries a released event for up to **3 days**. Narrow but real: if Resend *accepts* the email but the response times out, all 3 local send attempts fail, the `*_sent_at` claim is released, and a Stripe retry **>24 h later** re-sends a duplicate (`resend_email_id` doesn't prevent it — it's recorded only on a successful response). Fully closing this needs durable send-state reconciliation for ambiguous/timed-out requests (query Resend by idempotency key before re-sending), which is disproportionate to a sub-1%-of-a-rare-case window. **Decision: accept the residual and document it** here + in the runbook; the belt-and-braces claim + 24 h key already covers the common retry-within-a-day case. Revisit only if duplicate confirmations are observed.
- [ ] Green + commit: `fix(email): Idempotency-Key on Resend sends so claim-retry can't double-send (M-27)`

## Database / migration work

One tiny additive migration for Task 2's crash-window fix: `alter table orders add column if not exists refund_pending_at timestamptz;` (nullable, no default, no backfill). Set before `refunds.create`, cleared on the `pending→failed` CAS; pending consumers (abandoned-checkout cron, expiry) must exclude `refund_pending_at IS NOT NULL`. Backward-compatible — old code ignores the column (the marker is only *written* by the new code; the risk it guards only exists once the new refund-first path is live, so there's no old-code window that needs it). Auto-applies on merge; rollback = drop the column (reverts to the crash-window residual). L-4's claim-scoping uses the existing `processing_started_at` column (no migration).

## External-system changes

None. (Resend `Idempotency-Key` is a request header, no dashboard config. The dispute alert requires `charge.dispute.created` to be subscribed — it already is, per the audit's live endpoint listing; the Plan 01 drift guard will enforce it.)

## Tests

- **Modified:** route tests asserting dedupe-200 during an active lease (now 409); any snapshot of the deps object shape.
- **New (enumerated — the release gate requires every one, do not collapse to a round number):**
  - Task 1 (H-1): reserved→sold UPDATE error → throw/5xx, no refund. *(1)*
  - Task 2 (M-5): refund-pending marker set before `refunds.create`; `23505` → refund-once + `failed` (marker cleared) + 200 + alert; redelivery over already-`failed` → follow-up lookup → 200, no re-refund; **crash after refund, before CAS → order stays `pending` with marker → abandoned cron skips it**; zero-row CAS + missing/unexpected order → throw; non-`23505` CAS error → throw. *(5)*
  - Task 2 (failed-consumer contract): captured-then-refunded `failed` order → no fulfilment / no pending-cron action / absent from account lists / `customerOrderStatus` not a normal delivery state. *(≥3)*
  - Task 3 (M-21/M-22/L-4): seen-SELECT error → throw; active-lease → 409; stale-claim release writes zero rows. *(3)*
  - Task 4 (L-6): `charge.dispute.created` → deadline-bearing alert. *(1)*
  - Task 5 (L-5/L-7): invoice failure → alert + still 200; **one regression per enumerated `console.error`-only catch** upgraded to Sentry (count = the number of catches found, listed in the PR — not a round number). *(1 + N)*
  - Task 6 (M-27): `sendResendTemplate` sends `Idempotency-Key: order-confirmation/<orderId>`; `sendResendHtml` sends `studio-new-order/<orderId>`; each omits the header when no key passed. *(≥3)*
  - Regression: full `payment_intent.succeeded` happy path → 200 with all claims stamped. *(1)*
  Total ≥ 17 task-level cases + one per L-7 catch (not "six"); the gate is the enumerated list, not the number.
- **Failure modes simulated:** asymmetric piece_state write failure; `23505` on the order CAS; ledger SELECT failure; concurrent delivery during a lease; stale lease release; Resend timeout + retry; a `failed`-status order reaching each consumer.

## Verification

- **Local/unit:** `npx vitest run src/app/api/stripe/webhook/route.test.ts src/lib/webhook.test.ts src/lib/email.test.ts` — paste the run; confirm **every enumerated task-level case** above is present and green (the gate is the enumerated list incl. one test per L-7 catch, not a total count). `npm run lint && npm run typecheck && npm test`.
- **Preview:** drive one test-mode checkout through the preview webhook (can piggyback Plan 05's rehearsal) — confirm 200 + all rows/claims correct with the new code.
- **Live read-only:** after deploy, watch the Stripe delivery log for the first real deliveries — all 2xx (or expected 409-then-2xx pairs under concurrent redelivery).
- **Live mutation:** none.

## Rollout / recovery

1. Single PR (`fix:`), after Plan 01 merges (shared files).
2. The M-22 change (409 on active lease) alters Stripe-visible behaviour: concurrent duplicate deliveries now show as failed attempts that later succeed. Note this in the PR so nobody "fixes" the 409s back.
3. **Rollback:** revert the PR; all changes are stateless code paths, nothing to unwind.
4. **Stop signals:** sustained 409s for the *same* event beyond the 5-min lease (indicates a stuck lease — investigate before assuming Stripe's fault); any refund created by the M-5 path (should be near-impossible; each one deserves a manual review).

## Acceptance criteria

- [ ] Every enumerated task-level test (see Tests — incl. one per L-7 catch and both email helpers/senders) present and green; full webhook suite green (pasted).
- [ ] A simulated asymmetric failure no longer auto-refunds; a simulated double-paid private sale refunds exactly once and returns 200.
- [ ] Active-lease redelivery returns 409; `done` rows still dedupe-200.
- [ ] `charge.dispute.created` produces a deadline-bearing alert.
- [ ] Resend requests carry `Idempotency-Key` on claim-based sends.
- [ ] One preview test-mode checkout passes end-to-end on the new code.

## Dependencies

- **Plan 01** first (same files: `webhook.ts` constant + deps object). Plan 05's rehearsal is the convenient preview vehicle but not a hard dependency.

## Risks / unresolved questions

- M-22's 409 semantics: if a handler legitimately runs longer than 5 min (it shouldn't — Stripe's own timeout is shorter), the event redelivers and 409s until the lease expires; the lease TTL (`STRIPE_LEASE_MS`) may deserve tuning down to ~2 min in the same change — decide from the p99 handler duration visible in Workers logs.
- M-5 terminal state is **decided as `failed`** (see Task 2 — `pending` is unsafe because the abandoned-checkout cron and other pending flows would act on it). The consumer audit is now a Task 2 **gate** (not an open question): account lists, admin fulfilment, print worker, and conversions all correctly require/allow only `paid`/`refunded`; the one code change is fixing `customerOrderStatus` so a `failed` order is not rendered as a normal delivery state. If a *future* consumer needs to distinguish "failed + a real refund", add a marker (e.g. `refunded_reason`) rather than reverting to `pending`.
