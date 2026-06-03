# Stripe payments — design spec

**Date:** 2026-06-02
**Branch:** `feat/stripe-payments` (PR → `main`)
**Status:** Approved design, ready for implementation plan

## Goal

Replace the simulated checkout in [`CartView.tsx`](../../../src/components/shop/CartView.tsx)
with **real Stripe payments** for one-of-a-kind ceramics, on the existing Next.js 16 /
Cloudflare Workers (OpenNext) stack.

## Decisions (locked)

| Topic | Decision |
|---|---|
| Source of truth (orders + inventory) | **Supabase (Postgres)** — orders ledger + per-piece sold/reserved state, atomic reservation. Catalog prices/metadata stay in-code. |
| Checkout UI | **Embedded Payment Element** on `/koszyk` (full brand control). |
| Payment methods / currency | **PLN** — cards + **BLIK** + **Przelewy24** (+ Apple/Google Pay where available). |
| Inventory protection | **Hard reservation** at PaymentIntent creation, **15-minute TTL** hold. |
| Tax / invoicing | **No VAT** (Canary Islands residency). Full-price invoice via **Stripe Invoicing**, emailed by Stripe; Stripe payment receipt to customer. |
| Seller notification | **Stripe Dashboard alerts** (no custom seller email). |
| Stripe account | **Anna-ciok** — `acct_1Qiwd0J0KFK9lrjH` (build in **test mode** first, then live). |

## Key constraints discovered

- **BLIK requires PaymentIntent-first** (it is *not* supported in the deferred-intent flow).
  So the server creates the PaymentIntent before the Payment Element mounts — which also fits
  the reservation model (one server call reserves + creates the PI).
- **BLIK/Przelewy24 are async/redirect** methods. Fulfillment must be **webhook-driven only**;
  the client confirmation callback is never trusted as proof of payment.
- **Przelewy24 requirements:** the site must show seller legal details + refund & privacy
  policy (already present: `regulamin`, `polityka-prywatnosci`, `dostawa-i-zwroty`), and the
  checkout must present P24's hyperlinked Terms-of-Service consent text.
- **Workers runtime:** Stripe SDK must use the fetch-based HTTP client and
  `stripe.webhooks.constructEventAsync` (the sync verifier needs Node crypto, unavailable on
  Workers). Webhook route reads the **raw body** (`await req.text()`).

## Architecture (data flow)

```
Client (/koszyk)                Next API routes (Workers)         Supabase           Stripe
  │  cart = [ids]
  ├─ POST /api/checkout ───────▶ validate ids + prices
  │                              reserve_pieces(ids, 15min) ──────▶ atomic hold
  │                              create PaymentIntent (PLN) ───────────────────────────▶ PI
  │  ◀── client_secret ─────────
  ├─ mount Payment Element (cards/BLIK/P24) + shipping/email
  ├─ confirmPayment(return_url=/koszyk/return) ──────────────────────────────────────▶
  │                                                          (redirect/async for BLIK/P24)
  ▼
/koszyk/return ── shows status (reads PI status)

Stripe ── webhook ──▶ POST /api/stripe/webhook
   payment_intent.succeeded → mark sold + order paid ──▶ Supabase
                            → create+finalize invoice (no VAT) ─────────────────────────▶ invoice email
                            → on-demand revalidate collection pages
   payment_failed/canceled/expired → release hold ─────▶ Supabase
```

Amounts are always computed **server-side** from the authoritative catalog. The client never
sends prices.

## Data model (Supabase / Postgres)

- **`orders`** — `id` (uuid PK), `payment_intent_id` (unique), `status`
  (`pending`|`paid`|`failed`|`expired`), `currency`, `subtotal`, `shipping`, `total`
  (integers in grosze), `shipping_method`, `email`, `shipping_address` (jsonb),
  `created_at`, `paid_at`.
- **`order_items`** — `order_id` (FK), `product_id` (e.g. `k01`), `unit_price`. One row per
  reserved piece.
- **`piece_state`** — `product_id` (PK), `status` (`available`|`reserved`|`sold`),
  `reserved_until` (timestamptz, nullable), `order_id` (nullable). Seeded with all 88 ids;
  the current hardcoded `SOLD` set (`k04, k11, k19, v02, v06`) seeded as `sold`.
- **`reserve_pieces(ids[], order_id, ttl)`** — Postgres function: `SELECT … FOR UPDATE`,
  reject if any piece is `sold` or `reserved` with `reserved_until > now()`, else mark
  `reserved` with `reserved_until = now() + ttl`. Returns success or the conflicting ids.
  This is the atomic guard against double-sale.
- **Availability rule (everywhere):** *available = not `sold` AND (`reserved_until` IS NULL OR
  `reserved_until` < now())*. Expired holds self-heal lazily — no cron needed.
- Service-role key used server-side only; RLS denies anon writes.

## Reflecting sold state on the site (perf-safe)

- Collection pages stay **static/ISR** (preserving recent perf work).
- The webhook triggers **on-demand revalidation** when a piece sells, so pages refresh promptly.
- `/api/checkout` re-validates against Supabase at purchase time, so a stale page can **never**
  sell a gone piece (defence in depth).
- Product rendering gains a server-side `getSoldIds()` from Supabase, merged with the in-code
  catalog; `resolveCartProducts` consults it.

## Pricing (EUR → PLN)

Rule: rate **4.20** (rounded down in the buyer's favour vs the live ~4.2x rate; final live rate
confirmed at implementation), then **round down to the nearest 5 zł**. Pickup stays free.

| Kategoria | EUR | × 4.20 | **PLN** |
|---|---|---|---|
| kubki | 22 | 92.4 | **90** |
| wazony | 50 | 210 | **210** |
| wazony-duże | 95 | 399 | **395** |
| talerzyki | 25 | 105 | **105** |
| talerze-duże | 65 | 273 | **270** |
| duże-michy | 75 | 315 | **315** |
| miski-falowane | 38 | 159.6 | **155** |
| dostawa (kurier) | 18 | 75.6 | **75** |

- `euro()` in [`format.ts`](../../../src/lib/format.ts) becomes a `pln()` formatter (`90 zł`).
- `Product.price` / `CATEGORIES` prices in [`products.ts`](../../../src/lib/products.ts) update
  to PLN; i18n shipping strings (`ship.courierPrice`, `ship.pickupPrice`, etc.) update too.
- Stripe amounts stored/charged in **grosze** (integer).

## Components & routes

- **`/api/checkout`** (POST) — validate cart + recompute amount, `reserve_pieces`, create
  PaymentIntent (PLN, methods cards/BLIK/P24), persist `pending` order, return `client_secret`.
  On conflict return **409** with the sold-out ids.
- **`/api/stripe/webhook`** (POST) — `constructEventAsync`; idempotent handling of
  `payment_intent.succeeded` / `.payment_failed` / `.canceled`; mark state, generate the
  no-VAT invoice, trigger revalidation. Idempotency via `orders.payment_intent_id` uniqueness.
- **`CartView.tsx`** — replace simulated `handleCheckout` with the real flow:
  `@stripe/stripe-js` + `@stripe/react-stripe-js` `<Elements>` + `<PaymentElement>`,
  shipping address + email collection, P24 ToS consent, `confirmPayment` with
  `return_url=/koszyk/return`. Keep GTM `begin_checkout`; fire **`purchase` from the confirmed
  return path**, not optimistically.
- **`/koszyk/return`** — post-redirect status page (success / processing / failed); clears the
  cart on success. Remove the random `ACC-####` simulation and the `sim-banner`.
- **`src/lib/stripe.ts`** — server Stripe client (fetch HTTP client, pinned `apiVersion`).
- **`src/lib/supabase.ts`** — service-role client, server-only.

## Secrets & config (Cloudflare / Wrangler)

- Server-only secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`.
- Public: `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`.
- Build & verify in **test mode**, then flip to live keys.
- New runtime deps: `stripe`, `@stripe/stripe-js`, `@stripe/react-stripe-js`,
  `@supabase/supabase-js`.

## Error handling & edge cases

- Reservation conflict → **409** with specific sold-out ids; cart prunes them and informs user.
- Expired hold → piece auto-returns to sale (lazy availability rule).
- Webhook idempotency via unique `payment_intent_id`; duplicate events are no-ops.
- BLIK timeout / P24 abandonment → `payment_failed` / `canceled` releases the hold.
- Stripe/Supabase outage → checkout **fails closed**: never reserve without a PI, never mark
  sold without a verified webhook.

## Testing

- **Vitest unit:** price/amount computation, `reserve_pieces` conflict logic (against a Supabase
  test schema), availability rule, webhook event handling (mocked Stripe events) incl.
  idempotency.
- **Manual:** Stripe test cards + BLIK/P24 test flows via Stripe CLI (`stripe listen` /
  `stripe trigger`) against the local webhook.

## Out of scope (YAGNI)

No customer accounts/login, no admin panel (Dashboard suffices), no Stripe Tax, no
multi-currency, no saved cards/recurring payments, no custom seller emails.

## Open item to validate during implementation

Exact Stripe Invoicing mechanism for a **post-payment, no-VAT** invoice document emailed by
Stripe (create Customer → create Invoice with full-price line items → finalize → mark paid /
send), validated against the live Stripe API via the Stripe MCP. The charge itself is a
PaymentIntent; the invoice is the formal document.
