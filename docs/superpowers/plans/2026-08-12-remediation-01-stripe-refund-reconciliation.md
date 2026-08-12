# Remediation 01 — Stripe refund reconciliation (C-1 / H-3 / M-28) — P0

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> Source audit: `docs/audits/backend-audit-2026-08-12.md` (§4 C-1, §4 H-3, §5 M-28, §13 Opp-2/Opp-3, §15.1). Evidence below re-verified against HEAD `3da7ee0` on 2026-08-12.

**Goal:** Make refunds actually reconcile in production — subscribe the missing Stripe event, add a `refund.failed` alert leg, build a drift guard + reconciliation command so this class of failure can never be silent again, and backfill the one already-broken order.

**Architecture:** The convergence code (`releaseSale`) is already correct, idempotent and crash-resume-safe; the defect is *configuration* (the live endpoint never receives `charge.refunded`). The plan therefore is: small code additions (handled-event constant, `refund.failed` alert, two `orders`-CLI commands), one gated live Stripe config change, one gated backfill run.

**Tech stack:** stripe-node 22.2.1 (bundled API `2026-05-27.dahlia`), orders-CLI DI pattern (`scripts/orders-cli.ts`), Vitest.

## Objective

1. Every full refund — from admin UI, `orders` CLI, or Stripe Dashboard — flips the order `paid→refunded`, relists the piece, cancels Prodigi print fulfilment, and reverses GA4 revenue (C-1).
2. An asynchronously *failed* refund (`refund.failed`, up to ~30 days later) alerts the studio instead of passing silently (H-3, the actually-dangerous leg).
3. Config drift between the live endpoint's `enabled_events` / API version and the code's handled set / SDK-bundled version is detectable by one command (Opp-2), and refund state is reconcilable by one command (Opp-3).
4. The false "account-default API version" model is corrected in code + docs, and the API version is pinned explicitly so `npm update stripe` can't silently move it (M-28).
5. The existing production damage (order `8be30881-4f02-44a6-9627-221f54c67125` still `paid`, piece `s15` still `sold`) is backfilled.

## Findings covered

- **C-1** (CRITICAL) — `charge.refunded` not subscribed on the live endpoint; refund pipeline dead in prod. → PLANNED
- **H-3** (MEDIUM) — legacy refund model; `refund.failed` entirely unhandled. → PLANNED (the `refund.failed` alert leg). The full migration to `refund.created`/`refund.updated` as the *primary* trigger is consciously **DEFERRED**: `charge.refunded` remains a supported event, the full-refund-only guard + `releaseSale` logic is tested against it, and re-keying the trigger event is a money-path rewrite with no additional safety today. Revisit if Stripe deprecates `charge.refunded` or if partial-refund handling is ever needed.
- **M-28** (MEDIUM) — API-version model documented wrong; SDK v22 pins its bundled version per request. → PLANNED
- **Opp-2** — webhook-config drift guard. → PLANNED
- **Opp-3** — refund reconciliation sweep. → PLANNED
- Related but implemented elsewhere: the audit's "belt-and-braces (a)" (make `refundOrder` perform the CAS+relist inline) is **DEFERRED** — duplicating `releaseSale`'s 3-way CAS in a second call path adds a divergence risk, and the reconciliation command (this plan) plus the drift guard already give two independent safety nets. Revisit only if webhook delivery proves unreliable in practice.

## Current-state evidence

All `VERIFIED` at HEAD `3da7ee0` unless marked otherwise:

- `VERIFIED` `src/lib/webhook.ts:40-92` — `handleStripeEvent` switch handles exactly: `payment_intent.succeeded` (:42), `payment_intent.canceled` (:53), `payment_intent.payment_failed` (deliberate no-op, :59-67), `charge.refunded` (:69-78, full-refund-only guard `charge.amount_refunded < charge.amount`), `charge.dispute.closed` (lost-only, :79), `default: return` (:89). No `refund.*` handling anywhere in `src/` (grep `'refund\.` = 0 hits).
- `VERIFIED` `src/app/api/stripe/webhook/route.ts:454-574` — `releaseSale`: pending→refunded park CAS (:471-477), paid→refunded CAS (:487-493), `cancelPrintFulfilment` (:506), `sendRefundConversion` via `ctx.waitUntil` (:515-528), sold→available relist scoped to `order_id` + `status='sold'` (:536-541), crash-resume fallback (:549-573). Idempotent and correct — do not modify in this plan.
- `VERIFIED` `src/lib/admin/actions.ts:49-84` — `refundOrder` creates the Stripe refund (idempotency key `admin_refund_${pi}`, :68-71), cancels Prodigi inline (:82), writes **no** `orders.status` / `piece_state`, returns `` ok(`Zwrot utworzony (${refundId}). Status zaktualizuje webhook.`) `` (:83). This is why the missing subscription strands every refund.
- `VERIFIED` `src/lib/stripe.ts:4-14` — JSDoc claims "the **account-default API version**"; client is constructed with no `apiVersion`. Same unpinned pattern in `src/lib/admin/clients.ts:31-33` (`adminStripeFromEnv`). `package-lock.json` resolves `stripe@22.2.1`. Per https://docs.stripe.com/sdks/set-version, stripe-node ≥ v12 pins its bundled version on every request — the JSDoc and the AGENTS.md "API-version ritual" paragraph are factually wrong.
- `VERIFIED` `scripts/reconcile-orders.mjs` — five modes, all keyed on `status='paid'`; **no Stripe client exists in the script at all** (only Supabase/Resend/InPost). Nothing anywhere reconciles refunds.
- `VERIFIED` `scripts/orders-cli.ts` — DI pattern to reuse: `stripeFactory` dep (:54, default `adminStripeFromEnv` :65), `resolveStripeKey(env)` (:189-193, `ADMIN_STRIPE_SECRET_KEY || STRIPE_SECRET_KEY`), `loadCliEnv` precedence `.env.local → .dev.vars → --env-file → process.env` (:157-174), `--confirm <order-id>` + non-prod block via `scripts/prod-target.json`.
- `VERIFIED` grep `enabled_events` — zero hits outside the audit doc; the webhook route test's Stripe mock exposes only `webhooks.constructEventAsync` + `refunds.create` (`route.test.ts:5-9`), so no existing test can observe endpoint config.
- `CONFIRMED-LIVE` (from the audit, not re-checkable read-only from the repo) — live endpoint `we_1TgXEgJ0KFK9lrjHNbgIUSbr` `enabled_events` lacks `charge.refunded`; order `8be30881-4f02-44a6-9627-221f54c67125` is `status='paid'` with a succeeded full 139 zł refund (`pi_3Tw1WWJ0KFK9lrjH0YnXK5rg`); piece `s15` is `status='sold'`. → `NEEDS-RUNTIME-VERIFICATION` at implementation time (state may have been manually fixed since the audit; re-read before mutating).
- `NEEDS-RUNTIME-VERIFICATION` §15.1 — whether a Stripe **v2 Event Destination** exists that already subscribes `charge.refunded` (the MCP connector lists only legacy endpoints).

## Desired end state

- The live endpoint's `enabled_events` ⊇ the code's handled set **plus** `refund.failed`.
- `src/lib/webhook.ts` exports a `HANDLED_STRIPE_EVENTS` constant that is the single source of truth for "what we need subscribed"; a new `refund.failed` branch alerts the studio (email + Sentry) without mutating order state.
- `npm run orders -- webhook-config-check` fails loudly when the endpoint's `enabled_events` ⊉ handled set or its API version ≠ the SDK request version.
- `npm run orders -- reconcile-refunds` (dry-run by default) lists fully-refunded Stripe payments whose DB order is not `refunded`, and with `--confirm <order-id>` converges one order (status CAS + relist + Prodigi-cancel check), with `--skip-relist` for pieces that should stay off sale.
- Order `8be30881…` is `refunded`; `s15` disposition decided by the operator and applied.
- `src/lib/stripe.ts` + `src/lib/admin/clients.ts` pin `apiVersion` explicitly; JSDoc + AGENTS.md corrected.

## Scope

- `src/lib/webhook.ts` (constant export + `refund.failed` branch + deps threading for the alert)
- `src/app/api/stripe/webhook/route.ts` (only: wire the new alert dep into `handleStripeEvent`'s deps object; no changes to `markPaid`/`releaseSale` — those belong to Plan 06)
- `src/lib/stripe.ts`, `src/lib/admin/clients.ts` (apiVersion pin)
- `scripts/orders-cli.ts` (+ its test file) — two new commands
- `AGENTS.md` (API-version ritual paragraph), `docs/stripe-operations.md` (runbook additions)
- Tests: `src/lib/webhook.test.ts`, `src/app/api/stripe/webhook/route.test.ts` (only if the deps object change requires it), orders-cli tests
- **External (gated):** Stripe live endpoint `enabled_events` update; live backfill run

## Out of scope

- `markPaid`/ledger/lease hardening (H-1, M-5, M-21, M-22, L-4) → Plan 06.
- Rewriting the refund trigger onto `refund.created`/`updated` (see Findings covered — deferred).
- Making `refundOrder` converge inline (deferred, rationale above).
- Any change to `releaseSale`'s logic.
- Unsubscribing the five currently-subscribed no-op events (`payment_intent.created/processing/requires_action`, `charge.captured`) — record them in the drift guard's "subscribed-but-unhandled" warning output, but leave the live config trim as an operator option; it is not required for correctness.

## Implementation steps

### Task 1 — handled-events constant + `refund.failed` alert branch (code)

- [ ] In `src/lib/webhook.ts`, export the source-of-truth constant (place near the top, above `handleStripeEvent`):

```ts
/**
 * Events this handler needs delivered. The live endpoint's enabled_events
 * must be a superset — asserted by `npm run orders -- webhook-config-check`.
 * Keep in lockstep with the switch in handleStripeEvent.
 */
export const HANDLED_STRIPE_EVENTS = [
  'payment_intent.succeeded',
  'payment_intent.canceled',
  'payment_intent.payment_failed',
  'charge.refunded',
  'charge.dispute.closed',
  'refund.failed',
] as const;
```

- [ ] Write the failing tests first in `src/lib/webhook.test.ts`:
  - a `refund.failed` event calls a new `deps.alertRefundFailed(refund)` exactly once and does **not** call `releaseSale`/`markPaid`;
  - every member of `HANDLED_STRIPE_EVENTS` reaches a non-default branch (guards the constant against drifting from the switch — construct a minimal event per type and assert the corresponding dep was invoked or, for `payment_intent.payment_failed`, that the documented no-op comment path returns without calling any dep).
- [ ] Run `npx vitest run src/lib/webhook.test.ts` — expect the new tests to FAIL (no branch yet).
- [ ] Add the branch to the switch (before `default`):

```ts
case 'refund.failed': {
  const refund = event.data.object as Stripe.Refund;
  // A refund the customer never received (closed account / expired card,
  // up to ~30 days later). No automatic state change — the order stays
  // `refunded` in the DB; a human must re-issue the refund another way.
  await deps.alertRefundFailed(refund);
  return;
}
```

- [ ] In `src/app/api/stripe/webhook/route.ts`, implement `alertRefundFailed` in the deps object passed to `handleStripeEvent`, following the existing studio-alert shape in the file (Resend studio email via the existing email helpers + `Sentry.captureMessage('stripe_refund_failed', …)` with `payment_intent`, `refund.id`, `refund.failure_reason` in `extra`). Do not include customer PII beyond the order id.
- [ ] Run `npx vitest run src/lib/webhook.test.ts src/app/api/stripe/webhook/route.test.ts` — expect PASS.
- [ ] Commit: `feat(stripe): handle refund.failed with a studio alert; export HANDLED_STRIPE_EVENTS`

### Task 2 — pin the API version + fix the false docs (M-28)

- [ ] In `src/lib/stripe.ts` and `src/lib/admin/clients.ts`, pass `apiVersion: '2026-05-27.dahlia'` to every `new Stripe(...)`. TypeScript constrains this literal to the bundled version, so a future `npm update stripe` fails typecheck instead of silently moving the version — state this in the JSDoc.
- [ ] Rewrite the `src/lib/stripe.ts` JSDoc: stripe-node ≥ v12 pins its bundled API version on every request; the account default is *not* used. Source: https://docs.stripe.com/sdks/set-version
- [ ] Update the AGENTS.md "API-version ritual" paragraph to the corrected model (the ritual — keep the Dashboard endpoint version matched to the bundled version on SDK bumps — stays; only the "SDK uses the account-default version" rationale is wrong).
- [ ] Run `npm run typecheck && npm run lint` — expect PASS.
- [ ] Commit: `fix(stripe): pin apiVersion to the SDK-bundled version; correct the version-model docs`

### Task 3 — `webhook-config-check` command (Opp-2)

- [ ] Add a `webhook-config-check` command to `scripts/orders-cli.ts` using the existing `stripeFactory`/`resolveStripeKey` pattern:
  - `stripe.webhookEndpoints.list()` → for each enabled endpoint whose URL host matches the prod domain (`anna-ciok.studio`): assert `enabled_events` ⊇ `HANDLED_STRIPE_EVENTS` (import from `@/lib/webhook`); assert endpoint `api_version` equals `stripe.getApiField('version')` (the SDK request version); print subscribed-but-unhandled events as a warning, missing-but-required events as an error.
  - Exit non-zero on any missing required event or version mismatch. Read-only — no `--confirm` needed.
- [ ] Test (orders-cli test pattern, mocked `stripeFactory`): one passing config, one missing `charge.refunded` (expect non-zero + named event in output), one version mismatch.
- [ ] Run the tests: `npx vitest run scripts/` (or the specific test file) — expect PASS.
- [ ] Document the command + a recommended cadence (run after any Stripe Dashboard change and after every `stripe` package bump) in `docs/orders-cli.md` and `docs/stripe-operations.md`.
- [ ] Commit: `feat(orders-cli): webhook-config-check drift guard (enabled_events + API version)`

### Task 4 — `reconcile-refunds` command (Opp-3 + backfill vehicle)

- [ ] Add a `reconcile-refunds` command to `scripts/orders-cli.ts`:
  - List Stripe refunds (`stripe.refunds.list`, paginate, bounded by `--since <ISO date>` defaulting to the ledger epoch 2026-06-01); keep only `status='succeeded'` refunds whose charge is **fully** refunded (`charge.amount_refunded === charge.amount` — fetch or expand the charge).
  - Join to `orders` by `payment_intent_id`; report every order whose status is not `refunded` (dry-run default, PII-redacted like the rest of the CLI).
  - With `--confirm <order-id>`: converge that one order by mirroring `releaseSale`'s semantics — CAS `paid→refunded` (and `pending→refunded`), relist `piece_state` rows `sold→available` scoped to `order_id`, and for print orders report (do not auto-run) the `cancelPrintFulfilment` follow-up. Flag `--skip-relist` leaves `piece_state` untouched (operator decides whether a refunded piece returns to sale — e.g. damaged-in-transit refunds must NOT relist).
  - GA4 refund reversal is **not** attempted from the CLI (no marketing context available offline) — print a note that analytics revenue for that order remains unreversed, so the operator can decide whether to adjust in GA4 directly.
  - Non-prod block without `--allow-nonprod`, same as every other mutation in the CLI.
- [ ] Tests (mocked stripe/supabase factories): dry-run reporting; `--confirm` performs exactly the two CAS-scoped updates; `--skip-relist` performs only the order CAS; a partial refund is excluded.
- [ ] Run: `npx vitest run scripts/` — expect PASS.
- [ ] Document in `docs/orders-cli.md`.
- [ ] Commit: `feat(orders-cli): reconcile-refunds sweep (dry-run default, per-order --confirm)`

### Task 5 — live config change + backfill (EXTERNAL, gated — see External-system changes)

- [ ] Pre-check §15.1 (read-only): confirm no v2 Event Destination already delivers `charge.refunded` (Stripe Dashboard → Developers → Event destinations, or `GET /v2/core/event_destinations`).
- [ ] **GATE (live mutation):** add `charge.refunded` and `refund.failed` to endpoint `we_1TgXEgJ0KFK9lrjHNbgIUSbr`'s `enabled_events` (Dashboard, or `stripe.webhookEndpoints.update`). Requires explicit operator approval at execution time.
- [ ] Run `npm run orders -- webhook-config-check` against prod — expect PASS (this is the post-change confirmation).
- [ ] Re-read live state of order `8be30881-4f02-44a6-9627-221f54c67125` and piece `s15` (read-only) — confirm still un-reconciled.
- [ ] **GATE (live mutation + operator decision):** run `npm run orders -- reconcile-refunds` dry-run; then `--confirm 8be30881-4f02-44a6-9627-221f54c67125`, with or without `--skip-relist` per the operator's answer to: *"was the s15 piece returned to the studio in sellable condition?"* Do not assume the answer.

## Database / migration work

None. Both new CLI mutations reuse existing columns and the same CAS predicates as `releaseSale`.

## External-system changes

| Change | System | Type | Pre-state check | Post-state check | Gate |
|---|---|---|---|---|---|
| Add `charge.refunded` + `refund.failed` to `enabled_events` | Stripe (live) | Config mutation | `webhook-config-check` fails naming both events; §15.1 v2-destinations check | `webhook-config-check` passes | **Explicit operator approval** |
| Backfill order `8be30881…` / piece `s15` | Supabase prod (via CLI) | Data mutation | Read order + piece rows; confirm `paid`/`sold` | Order `refunded`; piece per decision | **Explicit operator approval + relist decision** |
| (Optional) trim the 5 subscribed no-op events | Stripe (live) | Config mutation | drift-guard warning list | warning list empty | Operator option, not required |

Adding events to `enabled_events` is backward-compatible: the handler's `default: return` acks anything unexpected, and the ledger tolerates new event types.

## Tests

- **New:** `refund.failed` branch test; `HANDLED_STRIPE_EVENTS`↔switch completeness test (regression: someone adds a handler without updating the constant, or vice versa — the drift guard would then assert the wrong set); orders-cli tests for both commands covering: missing-event detection, version mismatch, full-vs-partial refund filtering, CAS scoping of the backfill, `--skip-relist`.
- **Extended:** none of the existing ~49 route tests need changes unless the `handleStripeEvent` deps-object type change breaks compilation — fix types only, no behavioral edits.
- **Failure modes simulated:** endpoint missing a required event; SDK/endpoint version drift; a partial refund (must NOT reconcile); reconcile against an already-`refunded` order (must no-op).

## Verification

Completion claims require pasted output from these runs, not code inspection:

- **Local/unit:** `npm run lint && npm run typecheck && npm test` — all green; specifically `npx vitest run src/lib/webhook.test.ts` shows the new tests passing.
- **Live read-only:** `npm run orders -- webhook-config-check` output showing PASS after the config change; a read of order `8be30881…` showing `status='refunded'` after the backfill; `npm run orders -- reconcile-refunds` (dry-run) showing an empty report.
- **Live mutation (separate approval):** the two gated steps in Task 5.
- **End-to-end (recommended, test-mode):** in Stripe **test mode**, refund a test-mode payment and observe the order flip `refunded` via the webhook — this exercises `releaseSale` in the real runtime for the first time. If no test-mode order exists, note that Plan 05's rehearsal covers this path instead.

## Rollout / recovery

1. Merge code (Tasks 1-4) — inert until the subscription exists.
2. Apply the Stripe config change (gate). From this moment every new refund converges automatically.
3. Watch the Stripe Dashboard webhook delivery log + Sentry for the first `charge.refunded` delivery; a 5xx here means `releaseSale` failed on real data — Stripe retries for 3 days, giving time to fix without data loss.
4. Backfill the historical order (gate).
5. **Rollback:** remove the two events from `enabled_events` (config-only, instant); the code paths are inert without deliveries. The backfill is a one-way data fix — recover by manually re-setting the order/piece rows if the operator decision was wrong.
6. **Stop signals:** repeated `charge.refunded` 5xx in the Stripe delivery log; any `piece_state` row flipping `available` for an order that was not fully refunded.

## Acceptance criteria

- [ ] `webhook-config-check` passes against the live account (pasted output).
- [ ] `refund.failed` delivery produces a studio email + Sentry event (verified in test-mode or via unit test + one manual test-mode trigger).
- [ ] Order `8be30881…` is `refunded`; `s15` state matches the recorded operator decision.
- [ ] `reconcile-refunds` dry-run reports zero unreconciled full refunds.
- [ ] `stripe.ts`/`clients.ts` pin `apiVersion`; AGENTS.md paragraph corrected; `npm run typecheck` green.
- [ ] All unit tests green.

## Dependencies

- None hard. §15.1 (v2 destinations) is folded in as Task 5's pre-check. Plan 06 (webhook hardening) touches the same route file — land this plan first to keep diffs separable; Plan 05 (rehearsal) provides the full E2E validation of the refund leg if test-mode E2E isn't run here.

## Risks / unresolved questions

- **Operator decision required:** should `s15` return to sale? (Blocks only the final backfill step.)
- `stripe.refunds.list` pagination volume is trivial today (1 refund) but the `--since` bound keeps the command O(recent) forever.
- If §15.1 reveals a v2 Event Destination already subscribing `charge.refunded`, re-evaluate: the DB proof says reconciliation is not happening regardless, so the fix target may become "why is the destination not delivering" instead of "subscribe the event".
