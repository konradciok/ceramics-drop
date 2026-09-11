# Production launch audit — 2026-09-11

Full-repo audit ahead of the production launch week: checkout + Stripe webhook
critical path, Prodigi fulfilment pipeline, storefront/catalog/pricing/i18n
surfaces, admin gates. Static checks at audit time: `npm run typecheck`,
`npm run test`, `npm run lint` all green.

Result: **no BLOCKER**; 3 HIGH and 4 MEDIUM code findings — all seven fixed in
this pass (see Fixed findings). Remaining items are operational checks that
cannot be closed from the repo (see Open launch checks) plus accepted LOWs.

## Fixed findings

### 1. HIGH — transient DB errors terminally parked paid print orders

`src/server/fulfilment/process-job.ts` — the `orders` and `order_items` loads
discarded the query's `error` channel and branched only on `!data`. A
transient Supabase 5xx/timeout (data `null`) was indistinguishable from "order
not paid" / "no print items": the job was written to terminal
`failed_action_required`, the queue message acked, no retry ever happened.
**Fix:** destructure and throw on both load errors (→ queue retry with
backoff), matching the claim path's discipline. Tests: two new cases in
`process-job.test.ts` assert the rethrow and that no `failed_action_required`
write happens.

### 2. HIGH — replay could leave a paid order with zero `order_items`

`src/app/api/checkout/route.ts` — the `orders` insert and the `order_items`
insert are two separate awaited writes. If the Worker isolate died between
them, the retry with the same `attemptId` hit the replay branch, which skipped
the items insert entirely and returned the live `client_secret`. The buyer
pays; `markPaid` flips pieces to `sold`; `createShipment` sees an empty cart;
and the under-fulfilment auto-refund computed `expectedCount = 0` and never
fired — silent captured revenue with no fulfilment. **Fix (two layers):**

- Replay backfill: on replay, head-count the order's items; if zero, insert
  them (a concurrent backfill's unique violation counts as success). A failed
  count answers `409 checkout_in_progress` (client keeps its attemptId and
  retries) instead of ever handing out the secret unverified.
- Safety net: `isUnderfulfilled` (`src/lib/fulfillment.ts`) now also returns
  true for `expected === 0 && fulfilled > 0` — pieces sold for an order with
  no ceramic line items take the same refund/relist/`failed` path.

Tests: two new checkout route tests (backfill inserts; count failure → 409)
and a new `fulfillment.test.ts` case.

### 3. HIGH — PLN cart displayed the registry price but charged the DB price

`src/lib/cart-lines.ts` resolves ceramic lines client-side against the static
code registry, while checkout charges the DB row's `price_pln` — diverging
after any admin price edit. **Fix:** `/koszyk/page.tsx` now loads
`getPublicProducts()` and passes a `ceramicPrices` (id → DB PLN price) prop
into `CartView`; `priceOfLine` prefers it for `pln`. EUR/GBP are per-category
maps identical on both sides and stay on the old path.

### 4. MEDIUM — purchase conversions recorded for auto-refunded orders

`src/app/api/stripe/webhook/route.ts` — `trackPurchase` ran unconditionally
after `markPaid`, including when `markPaid` had just refunded the buyer
(under-fulfilment, private-sale double-paid). The GA4/Meta revenue was never
reversed (the `refund` reversal only fires from `releaseSale`'s paid→refunded
transition). **Fix:** the `conversions_sent_at` claim now filters
`status = 'paid'`; refund-then-fail orders end `failed` before the claim and
never enter the ad platforms (nothing was sent, so nothing needs reversing).

### 5. MEDIUM — Prodigi 409-no-id path parked a job no watchdog could see

`src/server/fulfilment/process-job.ts` — a 409 duplicate whose body carried no
order id wrote `fulfilment_submitted` with **no** `prodigi_orders` row:
invisible to both the M-10 stranded-job watchdog (excludes
`fulfilment_submitted`) and the M-12 reconciliation sweep (only polls persisted
rows). **Fix:** mark `failed_retryable` and throw → the queue retries (the 409
normally carries the id on a later attempt; the existing `dupId` path then
recovers); exhausted retries land in the DLQ, which alerts. Test added.

### 6. MEDIUM — unguarded final job-status write could downgrade `shipped`

`process-job.ts` — the final `fulfilment_submitted` updates had no status
guard, so a delivery racing a Prodigi callback could overwrite a terminal
`shipped`. **Fix:** both finalization writes are now CAS-scoped
`.in('status', ['fulfilment_submitting'])`; 0 rows means a concurrent
delivery/callback finalized — logged and accepted. Test added.

### 7. MEDIUM — print shipping kept hardcoded FX after an admin rate edit

`src/lib/print-shipping.ts` hardcoded `EUR_TO_PLN/EUR_TO_GBP` while item
prices derive from the admin-editable `print_pricing_config` rates — an FX
edit at `/admin/pricing` moved item prices but not shipping. **Fix:**
`printShippingOf` accepts an optional `rates` param (defaults preserved for
SEO/feed callers); checkout loads `getPrintPricingConfig()` and passes it, and
`CartView` passes its existing `printPricing` prop. Ceiling rounding (never
undercharge shipping) unchanged.

## Open launch checks (operator, not code)

These cannot be closed from the repo; verify before/at launch:

1. **`drops` row** — every ceramic renders unpurchasable unless the prod DB
   has an `active` `drop-1` row in `drops` (`src/lib/ceramic-sale-state.ts`
   fail-closed, no alert). Verify with a prod DB read. Note
   `/api/admin/end-drop` is one click away from this state, by design.
2. **`SHIPPING_PLN`/`SHIPPING_EUR`/`SHIPPING_GBP`** — `src/lib/pricing.ts`
   still carries its own "confirm against the studio's InPost rates before
   launch" comment. Display and charge are consistent; the risk is margin.
3. **Checkout WAF rate-limit rule** — the in-memory limiter
   (`src/lib/checkout-rate-limit.ts`) is per-isolate by design and defers to a
   Cloudflare WAF rule; confirm that rule is actually deployed.

## Accepted LOW findings (not fixed, tracked here)

- `product_ids` PaymentIntent metadata can exceed Stripe's 500-char value
  limit on ~13+ item carts → checkout 502s after hold release (no state leak).
  `src/app/api/checkout/route.ts` PI metadata.
- Ceramics checkout validates email non-emptiness only, not format
  (`src/lib/shipx.ts`); the print path uses zod. Garbage addresses bounce
  silently downstream.
- Prodigi `webhook_events` insert-race answers 200 "In flight" on a fresh
  claim; recovery is the M-12 sweep (bounded).
- `Unknown`-stage `prodigi_orders` rows are re-polled every 6h indefinitely
  (API chatter, not correctness).

## Verified clean (no action)

Money/minor-unit math and currency handling end-to-end; inventory reservation
RPCs (`reserve_pieces` hardening) and private-sale reservation; the promo
claim/settle lifecycle and checkout rollback ordering; the Stripe webhook
idempotency ledger (lease/409 discipline); the admin Cloudflare Access gate;
HMAC-signed print assets; cron sweep lease/CAS logic (expiry, watchdogs);
cart localStorage crash-safety; i18n key parity across all four locales;
sitemap/feeds; `/konto` ownership filtering.

## Status

All seven code fixes merged with tests (`npm run test` 2547 passing,
typecheck + lint clean). The three open launch checks above remain operator
tasks for launch week.
