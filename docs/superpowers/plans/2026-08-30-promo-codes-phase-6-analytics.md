# Promo Codes — Phase 6: Analytics (GA4 + Meta, client + server)

> **For agentic workers:** Part of `2026-08-30-promo-codes-master.md` — master decisions/constraints binding. Depends on Phases 2–3. Worktree `feat/promo-codes`; commit per green step; self-review loop at the end.

**Goal:** Promo usage is visible across the funnel using the repo's established conventions: `site_engagement` for application attempts, the standard GA4 `coupon` parameter on `begin_checkout`/`purchase` (client dataLayer AND server Measurement Protocol), and a corrected server-side GA4 `value` for discounted orders. Meta CAPI needs no value change (it already sends `order.total`, which Phase 2 made post-discount). The existing dedup machinery (deterministic `purchase-<pi>` event id, `conversions_sent_at` claim, `acc_purchase_pi:<pi>` sessionStorage) is **not** modified.

**Files:**
- Modify: `src/lib/analytics.ts` (`buildBeginCheckoutEventFromItems`, `buildPurchaseEventFromItems` — add optional `coupon`/`discount`)
- Modify: `src/lib/checkout-analytics.ts` (`pushCheckoutStartedItemsOnce` options; checkout snapshot written by `rememberCheckoutForReturn`; `pushConfirmedPurchaseFromRememberedCheckout`)
- Modify: `src/components/shop/CartView.tsx` (fire promo events; pass coupon into begin_checkout + the return snapshot)
- Modify: `src/lib/marketing/ga4-mp.ts` (+`conversions.ts`) — server MP coupon + value
- Modify: tests colocated with each (`analytics` tests, `checkout-analytics.test.ts`, `ga4-mp`/`conversions` tests, `src/app/api/stripe/webhook/route.test.ts` if `ConversionOrder` loading changes)
- Modify (small): `e2e/analytics-funnel.spec.ts` if it asserts a closed dataLayer contract that the new fields would break — extend, don't fork.

**Event contract produced (document verbatim in Phase 7's runbook):**
- `site_engagement` / `engagement_type: 'promo_apply'`, properties: `{ result: 'valid' | PromoIneligibleReason | 'network_error', code: string, track: 'ceramics' | 'prints' }` — fired on every apply attempt outcome in CartView (via `buildEngagementEvent` + `pushDataLayer`; no dedup needed, attempts are legitimately repeatable).
- `begin_checkout`: event-level `coupon: <CODE>` when applied; `value` stays as currently built (verify what it is today — if it's subtotal-based, subtract the discount for consistency with purchase; encode whichever rule keeps client and server `value` semantics identical and write it down).
- `purchase` (client + server MP): event-level `coupon: <CODE>`; server `value = (order.subtotal − order.discount)/100`; client value from the snapshot's discounted figure. `transaction_id`/event ids unchanged.
- GA4 `refund` event (`sendRefundConversion`): value derives from order fields — verify it uses `total` or `subtotal`; if subtotal-based, apply the same `− discount` correction so a refunded discounted order reverses the right revenue.

---

## Task 1: Client builders + snapshot (TDD)

- [ ] **Step 1: Failing tests** — `buildBeginCheckoutEventFromItems`/`buildPurchaseEventFromItems` accept an optional `coupon?: string` and `discountMinor?: number` (major-unit conversion inside, matching the layer's major-unit rule) and emit GA4-standard `coupon` at event level; absent → payload byte-identical to today (regression assertions on an existing fixture). `pushCheckoutStartedItemsOnce` forwards coupon; the return snapshot round-trips `coupon` + discounted value through `rememberCheckoutForReturn` → `pushConfirmedPurchaseFromRememberedCheckout` (extend `checkout-analytics.test.ts` snapshot fixtures; keep the sessionStorage schema version key unchanged unless the parser is strict — if the snapshot parser rejects unknown fields, bump whatever version discriminator it uses and handle the old shape gracefully).
- [ ] **Step 2: Implement**; run to green.
- [ ] **Step 3: Commit** — `git commit -m "feat(promo): coupon on client begin_checkout/purchase and return snapshot"`

## Task 2: CartView wiring

- [ ] **Step 1:** In the Phase 3 apply/remove handlers, fire `promo_apply` engagement events for every outcome (valid/each reason/network error). In `handleCheckout`, pass the applied code into `pushCheckoutStartedItemsOnce` and include `coupon` + `discount` in the `rememberCheckoutForReturn` snapshot (use the **server-confirmed** `discount` from the checkout response where available, else the preview value).
- [ ] **Step 2:** Manual smoke on `npm run dev` with the GTM/dataLayer console (`window.dataLayer` inspection): apply a stubbed code, verify `site_engagement` and `begin_checkout.coupon` appear once each; refresh dedup still holds.
- [ ] **Step 3: Commit** — `git commit -m "feat(promo): promo_apply engagement events and coupon plumbed through checkout analytics"`

## Task 3: Server MP + conversions (TDD)

- [ ] **Step 1: Failing tests** — `buildGa4PurchasePayload` with `coupon`/`discountMinor` inputs emits `params.coupon` and `value = (subtotal − discount)/100`; without them, payload unchanged (regression). `sendPurchaseConversions` loads `promo_code`/`discount` on `ConversionOrder` (extend the type + the order select in `conversions.ts`) and forwards them; Meta CAPI payload asserted **unchanged** apart from nothing (value already `total/100`). Refund: per the contract above, correct `buildGa4RefundPayload`/`sendRefundConversion` value if and only if it's subtotal-based — write the test after reading the current implementation.
- [ ] **Step 2: Implement**; run the marketing + webhook test files to green.
- [ ] **Step 3: Commit** — `git commit -m "feat(promo): server GA4 MP coupon + discounted value; refund value aligned"`

## Task 4: Dedup + contract sweep

- [ ] **Step 1:** Re-read the full client/server event paths and confirm: no new event fires from both sides (promo_apply is client-only; coupon rides existing deduplicated events); `event_id` generation untouched; `conversions_sent_at` claim untouched. Run `e2e/analytics-funnel.spec.ts` (hermetic) and fix any contract assertion the new fields legitimately extend.
- [ ] **Step 2: Commit** — `git commit -m "test(promo): analytics funnel contract updated for coupon fields"` (skip if no spec change needed).

## Acceptance checklist (phase self-review)

- [ ] Attempts vs. redemptions are distinguishable in GA4 (`promo_apply` events vs. `purchase.coupon`); checkout track is available (`track` property + existing item categories).
- [ ] Client and server `purchase` events carry the same `coupon` and consistent `value` semantics for the same transaction (the dedup pair must not disagree).
- [ ] Zero behavior change for non-promo orders (regression tests in Tasks 1 & 3 prove payload identity).
- [ ] Major units everywhere in analytics; minor units never leak into dataLayer/MP values.
- [ ] Consent gating untouched: all new client events go through the existing consent-gated push path; server events remain inside `sendPurchaseConversions`' consent check.
- [ ] `npm run lint && npm run typecheck && npm run test` green; adversarial diff re-read done.
