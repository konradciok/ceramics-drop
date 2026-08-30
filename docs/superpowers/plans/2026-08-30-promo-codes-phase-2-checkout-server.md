# Promo Codes — Phase 2: Checkout server integration

> **For agentic workers:** Part of `2026-08-30-promo-codes-master.md` — the master's "Locked architecture decisions" and "Global constraints" are binding. Depends on Phase 1 (`src/lib/promo.ts` interfaces, migration RPCs). Execute in the `feat/promo-codes` worktree; commit after each green step; run the self-review loop at the end.

**Goal:** `/api/checkout` accepts an optional `promo_code`, validates it server-side, applies the discount to the PaymentIntent amount and the `orders` row, claims the redemption atomically, and the Stripe webhook + cron settle the redemption. Invoices reflect the discount. No UI yet (Phase 3) — after this phase a hand-crafted POST with a code works end-to-end in tests.

**Files:**
- Modify: `src/app/api/checkout/route.ts`
- Modify: `src/app/api/stripe/webhook/route.ts` (markPaid, releaseHold, ensureInvoiced deps)
- Modify: `worker.ts` **only if** the expiry sweep lives there rather than in the webhook module — locate the cron's expire-abandoned-orders step first and hook where the pieces are freed.
- Modify: `src/app/api/checkout/route.test.ts`, `src/app/api/stripe/webhook/route.test.ts`

**Interfaces:**
- Consumes (Phase 1): `normalizePromoCode`, `fetchPromoByCode`, `checkPromoEligibility`, `computePromoDiscountMinor`, RPCs `claim_promo_redemption` / `settle_promo_redemption`.
- Produces (Phases 3/6 rely on): request body field `promo_code?: string`; error responses 400 `{ error: 'invalid_promo', reason: PromoIneligibleReason }` and 409 `{ error: 'promo_exhausted' }`; success response unchanged plus `discount: number` (minor units) so the client can render the authoritative figure; `orders.promo_code` + `orders.discount` populated; PI metadata keys `promo_code`, `promo_id`.

---

## Task 1: Accept + apply the code in `/api/checkout` (TDD)

- [ ] **Step 1: Write failing tests** in `src/app/api/checkout/route.test.ts`, following the file's existing mock style (mocked Stripe + Supabase deps). New cases:
  1. Body with `promo_code: 'welcome10'` (percent 10, applies_to all, active) on a ceramic PLN cart: PI `amount = subtotal - floor(subtotal*0.10) + shipping`; `orders` insert has `promo_code: 'WELCOME10'`, `discount` = expected, `subtotal` unchanged (pre-discount), `total = subtotal - discount + shipping`, `shipping` = the explicit shipping amount; PI metadata contains `promo_code: 'WELCOME10'` and `promo_id`.
  2. Same on a **print** EUR cart (fixed `amount_eur`) — discount applied, print shipping untouched.
  3. `applies_to: 'ceramics'` code on a print cart → 400 `{ error: 'invalid_promo', reason: 'wrong_track' }`, **no** reservation left behind, no PI created (validate promo BEFORE `reserve_pieces` — same ordering principle as the existing `print_asset_unavailable` pre-checks).
  4. Inactive / expired / unknown code → 400 `invalid_promo` with matching `reason`.
  5. `claim_promo_redemption` RPC returns `false` → 409 `{ error: 'promo_exhausted' }` and the piece hold is released (claim runs after reserve; on failure, roll back the hold the same way the existing stale-attempt branch releases holds).
  6. No `promo_code` in body → byte-identical behavior to today (regression: reuse an existing passing case's assertions with discount 0 and no promo columns... columns default `discount: 0`, `promo_code` null/absent).
  7. Replay (same attemptId re-POST) with the same code → claim RPC called again but succeeds (re-entrant), no duplicate redemption assertions needed beyond RPC mocked `true`.
  8. Discount clamp: 100% code + `odbior` (0 shipping) PLN cart → PI amount exactly 200 (Stripe minimum).
- [ ] **Step 2: Run** `npx vitest run src/app/api/checkout/route.test.ts` — expect the new cases to FAIL.
- [ ] **Step 3: Implement in `route.ts`**, minimal diff:
  - Parse `promo_code` from the body → `normalizePromoCode`; malformed (non-null raw but normalize→null) → 400 `{ error: 'invalid_promo', reason: 'not_found' }`.
  - After `validateCart` and fulfilment-type determination, before `reserve_pieces`: `fetchPromoByCode` → `checkPromoEligibility(promo, track, redemptionCount)`; on failure → 400 with `reason` (map `exhausted` here to 409 `promo_exhausted`).
  - Compute `shipMinor` explicitly for BOTH branches (refactor the ceramic branch so shipping is its own variable rather than derived later as `amount − subtotalMinor` — the discount breaks that derivation). `discountMinor = computePromoDiscountMinor(...)`; `amount = subtotalMinor - discountMinor + shipMinor`.
  - After the reserve RPC succeeds and before PI creation: `supabase.rpc('claim_promo_redemption', { p_promo_id, p_order_id: orderId })`; `false` → release the hold (existing helper) → 409 `promo_exhausted`; RPC error → release hold → 500.
  - PI metadata: add `promo_code`, `promo_id` (only when present, matching the `private_sale_id` spread pattern). **Note:** the Stripe idempotency key is `pi_create_${orderId}` — a replay with a *different* amount (code added/removed between attempts) would 400 at Stripe; acceptable because the client resets `attemptId` whenever cart contents change, and Phase 3 must also reset it when the applied code changes (record this as a Phase 3 requirement — it is already listed there).
  - `orders` insert: `promo_code`, `discount: discountMinor`, `shipping: shipMinor`, `total: amount`.
  - Success JSON: include `discount: discountMinor`.
- [ ] **Step 4: Run** the file's full suite — all old + new cases PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(promo): checkout applies promo codes server-side to PI amount and order"`

## Task 2: Webhook settlement + cron release (TDD)

- [ ] **Step 1: Locate the three settlement points** in `src/app/api/stripe/webhook/route.ts` (and `worker.ts` for the cron): (a) `markPaid` — directly after the private-sale burn block (~583–595) is the model; (b) `releaseHold` (payment_failed/canceled); (c) the cron's expire-abandoned-orders sweep where reserved pieces are freed.
- [ ] **Step 2: Write failing tests** in `src/app/api/stripe/webhook/route.test.ts` (existing dep-injection style): `markPaid` on an order whose row has `promo_code` set calls `settle_promo_redemption` with `p_status:'redeemed'` and **throws** if the RPC errors (so Stripe retries — mirror the private-sale burn's error contract); orders without a promo never call it (guard on the loaded order's `promo_code`/discount to avoid a pointless RPC per order); `releaseHold` calls it with `'released'` and does NOT throw on error (releasing is best-effort — a stuck `pending` only over-counts toward max_redemptions, log + Sentry like other swallowed release errors).
- [ ] **Step 3: Implement** all three call sites. Cron sweep: settle `'released'` for the expired order id, best-effort, inside the sweep's existing try/catch + self-alert pattern.
- [ ] **Step 4: Run** `npx vitest run src/app/api/stripe/webhook/route.test.ts` — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(promo): webhook and cron settle promo redemptions (redeemed/released)"`

## Task 3: Invoice + email amounts audit

- [ ] **Step 1: Read `ensureInvoiced`** (webhook route) and the invoice line-item construction. Decide from what's actually there: if invoice lines are built from `order_items.unit_price` + shipping, the invoice total will exceed the charged amount for discounted orders. Add a discount line (negative `amount` invoice item labeled with the promo code, e.g. `Rabat / Discount (WELCOME10)`) so the invoice total equals `orders.total`. If invoicing is instead amount-based from the PI, verify and document that no change is needed.
- [ ] **Step 2: Read `buildOrderConfirmationEmail`** (`src/lib/email.ts:~1061`) — if it renders a totals table from order fields, add a discount row (only when `order.discount > 0`) using `emailDetailTable` conventions; extend `OrderConfirmationOrder` with `promo_code`/`discount`. Locale copy inline per house style (PL "Rabat", EN "Discount", ES "Descuento", DE "Rabatt").
- [ ] **Step 3: Tests** — extend the nearest existing tests (`webhook.test.ts` / email builder tests if present; otherwise add a focused unit test for the email builder showing the discount row appears iff `discount > 0`). Run them.
- [ ] **Step 4: Commit** — `git commit -m "feat(promo): discount reflected on invoice and order-confirmation email"`

## Acceptance checklist (phase self-review)

- [ ] Promo validation happens BEFORE piece reservation; every promo-failure path leaves no hold, no order row, no PI.
- [ ] `orders.subtotal` pre-discount; `shipping` explicit; `total = subtotal − discount + shipping`; PI amount === `orders.total`. Grep the route for any remaining `amount - subtotalMinor` shipping derivation.
- [ ] Fail-closed: no branch silently drops the code and charges full price.
- [ ] `markPaid` promo settle throws on RPC error (Stripe retry); release paths never throw.
- [ ] Refund path untouched (redeemed stays redeemed) — confirm `releaseSale` was NOT modified.
- [ ] No-promo requests produce byte-identical orders/PI vs. `main` (covered by regression case 6).
- [ ] `npm run lint && npm run typecheck && npm run test` green; full adversarial diff re-read done; fixes committed.
