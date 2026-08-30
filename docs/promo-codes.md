# Promo codes

Operator runbook and technical reference for the promo-code feature (2026-08-30). Both checkout tracks — ceramics and fine-art prints — support an optional code applied at the cart page and validated server-side at checkout.

Implementation plan: `docs/superpowers/plans/2026-08-30-promo-codes-master.md` (master + 7 phase prompts). This doc is the durable reference; the plan is historical.

## Operator runbook (`/admin/promotions`)

### Creating a promotion

Open **Promocje** in the admin nav. Click **Nowa promocja** and fill in:

| Field | Meaning |
|---|---|
| **Kod** | 3–32 characters (letters, digits, `-`, `_`). Uppercased and normalized server-side — the code you type is not necessarily the code stored. **Immutable after creation**: the edit form shows it disabled. A rename would orphan both the order-stats join (`orders.promo_code`) and the audit-log key (`promo:<CODE>`), so it is a hard rule, not a UI nicety. |
| **Rodzaj** | *Procentowy* (1–100%) or *Kwotowy* (fixed amount). A fixed promo requires an amount in **all three currencies** — PLN, EUR, GBP — entered in **major units** (zł/€/£) in the form; the editor converts to minor units before saving. |
| **Dotyczy** | *Wszystkiego*, *Tylko ceramiki*, or *Tylko printów* — which checkout track the code is eligible for. Ceramics and prints are always separate carts/orders, so this maps 1:1 to the cart the buyer is checking out. |
| **Obowiązuje od / do** | Optional schedule window (local time in the form, converted to UTC on save). Both ends optional; if both are set, start must be strictly before end. |
| **Limit użyć** | Optional cap on total redemptions (pending + redeemed count against it). |
| **Kampania** | Free-text operator label, not shown to customers. |
| **Kod powitalny newslettera** | At most **one** promotion may carry this flag while active — enforced by a DB constraint, surfaced as a clear error if you try to flag a second one. See "Newsletter welcome email" below. |

### Activating / deactivating

The **Aktywuj / Dezaktywuj** button toggles the promo instantly. Promo reads are never cached (`docs` decision, mirrors catalog/print-pricing), so deactivation takes effect for the **very next** checkout request. A buyer whose code was just deactivated mid-checkout gets a clear `invalid_promo` failure and can retry without the code — no stuck state, no risk of an under-charged order.

### Reading the stats columns

Each row shows live utilization, computed from the redemption ledger + paid/refunded orders (never a denormalized counter that can drift):

- **Użycia** — `redeemed/max` with a muted `(+N w toku)` suffix for pending claims (checkouts currently in flight, not yet paid or resolved).
- **pending** — claimed by a checkout that hasn't resolved yet (payment in progress, or abandoned but not yet swept).
- **redeemed** — the order was paid. **A refund on a paid order does NOT reduce this** — the master plan's explicit non-goal: refunding a paid discounted order keeps the redemption `redeemed` and counted (documented operator behavior, not a bug).
- **released** — never paid: checkout abandoned/expired/failed, or a refund arrived *before* the payment ever succeeded (not a clawback — that claim simply resolves like any other unpaid outcome).
- Stale `pending` rows on dead orders don't linger: a cron sweep every 15 minutes converges them to `released`/`redeemed` by the order's actual final status.
- **Udzielony rabat** / **Przychód** — sums of `orders.discount` / `orders.total` over paid+refunded orders carrying this code, per currency.
- **Ostatnie użycie** — the most recent `redeemed` timestamp.

### Newsletter welcome email

If a promo carries the **newsletter welcome** flag and is active, a new subscriber who completes double opt-in (clicks the confirm link) receives it in a localized welcome email, sent best-effort right after their subscription is confirmed. With no promo flagged, the flow is byte-identical to before this feature existed.

**Known edge case (stateless design, no dedup store):** the newsletter opt-in flow has no subscriber database — a re-click of an already-confirmed link is indistinguishable from a first confirm and will re-send the welcome email (with whatever promo is flagged *at that moment*, which may differ from the first send). Accepted as consistent with the flow's existing stateless design (memory: `subscribeNewsletterContact` already treats "already subscribed" as success).

**⚠️ Operator confirmation needed before enabling this flag in production:** the original requirement's "when someone will assign it's a new silter he will receive the promo code in the inviting email" is interpreted here as "new **newsletter** subscriber" — there is zero prior art in this codebase for "invite"/"silter"/"sitter" as a separate flow. The newsletter double opt-in is the only invitation-like email this repo sends. **This reading has not yet been confirmed by the operator.** Until confirmed, do not flag a promo `newsletter_welcome` in production — the code path is fully inert (identical to pre-feature behavior) while no promo carries the flag, so there is no risk in leaving it off.

## Technical reference

### Ownership model

Supabase — not Stripe — owns promotion definitions and redemption lifecycle. **Stripe PaymentIntents do not support Stripe-native coupons/promotion codes** (verified 2026-08-30: [Stripe support](https://support.stripe.com/questions/support-for-coupons-using-payment-intents-api), [Stripe docs](https://docs.stripe.com/payments/advanced/discounts)), and this store's checkout uses PaymentIntents throughout (not Checkout Sessions). The discount is computed server-side in `/api/checkout`, subtracted from the PaymentIntent `amount`, and the PI carries `promo_code`/`promo_id` metadata for Stripe-side reporting only — Stripe never adjudicates eligibility or redemption.

### Discount semantics

- Applies to the **merchandise subtotal only — never shipping**.
- `percent`: `floor(subtotalMinor * percent / 100)`.
- `fixed`: an explicit per-currency minor-unit amount (`amount_pln`/`amount_eur`/`amount_gbp`), clamped to the subtotal.
- **Stripe-minimum clamp:** the discount is further capped so the charge never falls below Stripe's per-currency minimum (`STRIPE_MIN_MINOR`: PLN 200 / EUR 50 / GBP 30 minor units) — `discount = min(discount, max(0, subtotalMinor + shippingMinor − STRIPE_MIN_MINOR[currency]))`. A cart already below the minimum before any discount keeps `discount = 0` (never negative, never rejected — that cart's chargeability isn't the promo's problem).
- One code per order, no stacking, no minimum-subtotal thresholds, no free-shipping promos (all explicit non-goals — schema leaves room, not built).

### Redemption lifecycle

```
                    claim_promo_redemption (checkout, after orders insert)
                              │
                              ▼
                          ┌─────────┐
                          │ pending │
                          └────┬────┘
              settle_promo_redemption            settle_promo_redemption
              ('redeemed', markPaid)              ('released', releaseHold /
                              │                     expiry cron / pending→
                              ▼                     refunded webhook branch)
                        ┌───────────┐          ┌──────────┐
                        │ redeemed  │          │ released │
                        └───────────┘          └──────────┘
                     (refund of a PAID          (terminal — never
                      order stays here —         re-claimed by this
                      no clawback)                order; a NEW checkout
                                                   attempt can claim fresh
                                                   capacity)
```

Both transitions are atomic RPCs (`supabase/migrations/20260830120000_promo_codes.sql`) mirroring `reserve_pieces()`'s concurrency pattern. `claim_promo_redemption` is re-entrant for the same order+promo (checkout replays), rejects a claim for a *different* promo on an order that already holds one (one code per order — a code change must regenerate `attemptId`, enforced client-side), and enforces `max_redemptions` under a `FOR UPDATE` lock. `settle_promo_redemption` reports whether the requested terminal state is actually recorded, so a late `markPaid` racing an expiry sweep can reconcile (re-claim + re-settle) instead of silently losing the redemption. A 15-minute cron sweep (`src/lib/promo-reconcile.ts`) converges any `pending` row that outlived its checkout window by re-deriving the correct terminal state from the order's actual status — self-healing against a transient best-effort settle failure.

### Error codes

- `POST /api/checkout` — 400 `{ error: 'invalid_promo', reason }` (`reason` ∈ `not_found | inactive | not_started | expired | wrong_track`); 409 `{ error: 'promo_exhausted' }` (capacity gone, including a race lost after PI creation — full rollback: PI canceled, order marked failed, hold released); 500 `{ error: 'promo_claim_failed' }` (claim RPC itself errored — same rollback).
- `POST /api/promo/validate` (cart preview) — 200 `{ ok: true, code, discount }` or 200 `{ ok: false, reason }` (a soft failure, not an HTTP error — matches the `/api/inventory`-style read contract); 400 `{ error: 'invalid_request' }` for a malformed code/empty cart; 429 rate-limited.
- `POST /api/admin/promotions` / `PATCH /api/admin/promotions/[id]` — 400 `invalid_code` / `code_immutable` / `validation_failed` (+ `fields`); 404 `not_found`; 409 `code_exists` / `newsletter_welcome_taken`.

### Analytics event contract

- `site_engagement` / `engagement_type: 'promo_apply'` — properties `{ result: 'valid' | PromoIneligibleReason | 'network_error', code, track: 'ceramics' | 'prints' }`. Fires on **every apply-attempt outcome** in the cart UI (attempts are legitimately repeatable — no dedup). Removing an applied code fires no event.
- `begin_checkout` (client dataLayer): event-level GA4-standard `ecommerce.coupon: <CODE>` when applied; `ecommerce.value` and `checkout_total` are subtotal-minus-discount-plus-shipping (byte-identical to the pre-promo build when no code is applied — regression-tested).
- `purchase` (client dataLayer **and** server GA4 Measurement Protocol): `coupon` at event level; `value = (order.subtotal − order.discount) / 100` on both sides (kept in explicit sync so the client/server dedup pair never disagrees). Meta CAPI needs no change — it already sends `order.total`, which is post-discount by construction.
- GA4 `refund` event (`sendRefundConversion`, full-refund reversal only): `value = (order.subtotal − order.discount) / 100`, mirroring the purchase value it reverses.
- Existing dedup machinery (deterministic `purchase-<payment_intent_id>` event id, `orders.conversions_sent_at` claim, `acc_purchase_pi:<pi>` sessionStorage guard) is untouched by this feature.

## Files (for future maintainers)

| Layer | Files |
|---|---|
| Domain | `src/lib/promo.ts`, `supabase/migrations/20260830120000_promo_codes.sql` |
| Checkout | `src/app/api/checkout/route.ts`, `src/app/api/stripe/webhook/route.ts`, `src/lib/expire-orders.ts`, `src/lib/promo-reconcile.ts`, `worker.ts` (5th cron sweep) |
| Cart UI | `src/components/shop/CartView.tsx`, `src/app/api/promo/validate/route.ts`, `src/lib/checkout-client.ts` (`attemptIdentityKey`) |
| Admin | `src/app/admin/promotions/`, `src/app/api/admin/promotions/`, `src/lib/admin/promotions.ts` |
| Newsletter | `src/lib/newsletter.ts` (`buildNewsletterWelcomeEmail`), `src/app/api/newsletter/confirm/route.ts` |
| Analytics | `src/lib/analytics.ts`, `src/lib/checkout-analytics.ts`, `src/lib/marketing/ga4-mp.ts`, `src/lib/marketing/conversions.ts` |
| Invoicing / emails | `src/lib/invoice.ts` (discount line), `src/lib/email.ts` (studio order-email discount row) |
