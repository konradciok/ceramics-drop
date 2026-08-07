# Current state

Audit date: 2026-07-18. Paths are relative to the repository root.

## Architecture summary

The store is Next.js App Router deployed through OpenNext to Cloudflare Workers. The relevant pinned/resolved versions are:

| Component | Declared | Resolved / observed |
| --- | --- | --- |
| Application | `0.7.1` | `0.7.1` |
| Next.js | `^16.2.7` | `16.2.9` |
| React | `19.2.7` | `19.2.7` |
| `stripe` | `^22.2.0` | `22.2.1` |
| `@stripe/stripe-js` | `^9.7.0` | `9.8.0` |
| `@stripe/react-stripe-js` | `6.6.0` | `6.6.0` |
| OpenNext Cloudflare | declared in `package.json` | `1.19.11` |
| Wrangler | declared in `package.json` | `4.97.x` |
| Supabase JS | declared in `package.json` | `2.108.1` |

`package.json` deliberately builds with `next build --webpack`. `wrangler.jsonc` uses compatibility date `2026-06-02`, `nodejs_compat`, OpenNext assets/service bindings, R2 print assets, a fulfillment Queue and DLQ, a 15-minute cron, and Workers logging. `worker.ts` wraps the OpenNext fetch handler with Cloudflare Access protection, scheduled order expiry, and the Prodigi queue consumer. Sentry is initialized for server/worker error reporting.

The integration is **Payment Intents + Payment Element**. It does not use Checkout Sessions, embedded Checkout, Express Checkout Element, or Payment Links. Stripe creates the payment object; the application owns product validation, pricing, delivery collection, one-of-one inventory reservation, internal orders, email, analytics, and fulfillment.

## Relevant modules

| Responsibility | Exact implementation |
| --- | --- |
| Cart persistence | `src/store/cart.ts`, localStorage key `acc_cart_v1` |
| Cart token resolution | `src/lib/cart-lines.ts`, `src/lib/print-cart.ts` |
| Checkout UI and delivery collection | `src/components/shop/CartView.tsx` |
| Stripe form | `src/components/shop/CheckoutForm.tsx` (`PaymentElement`, `confirmPayment`) |
| Stripe.js provider | `src/components/shop/CartView.tsx` (`Elements` after `client_secret`) |
| Checkout API | `src/app/api/checkout/route.ts` |
| Server validation/pricing | `src/lib/checkout.ts`, `src/lib/pricing.ts`, `src/lib/print-pricing.ts`, `src/lib/print-shipping.ts`, `src/lib/shipx.ts` |
| Stripe server client | `src/lib/stripe.ts` |
| Return/status page | `src/components/shop/PaymentReturn.tsx` under the localized cart return route |
| Stripe webhook route | `src/app/api/stripe/webhook/route.ts` |
| Webhook state machine | `src/lib/webhook.ts` |
| Order persistence | `src/lib/orders.ts` |
| Inventory RPC client | `src/lib/inventory.ts` |
| InPost fulfillment | `src/lib/shipx.ts` and shipment helpers used by `src/lib/webhook.ts` |
| Prodigi enqueue/consumer | `src/server/fulfilment/enqueue.ts`, `src/server/fulfilment/process-job.ts`, `worker.ts` |
| Customer/studio email | `src/lib/email.ts` and calls from `src/lib/orders.ts`/`src/lib/webhook.ts` |
| Stripe Invoice generation | `src/lib/invoice.ts` |
| Server conversions | `src/lib/marketing/conversions.ts` |
| Browser ecommerce events | `src/lib/analytics.ts` and checkout/return components |
| Expired order cleanup | `src/lib/expire-orders.ts`, scheduled from `worker.ts` |
| Manual recovery | `scripts/orders-cli.ts`, `scripts/reconcile-orders.mjs`, `docs/orders-cli.md` |
| Print fulfillment diagnostics | `src/app/api/debug/fulfilment-status/route.ts`, Prodigi CLI/docs |

## Actual payment lifecycle

### 1. Add to cart

`src/store/cart.ts` persists a set-like list of tokens. Ceramics use stable product IDs; prints use `print:<design>:<size>:<framed>:<mount>:<frameColour>`. There are no quantities for ceramics. `src/lib/cart-lines.ts` resolves both types. `CartView` reconciles ceramic availability through `/api/inventory`. Mixed ceramic/print checkout is rejected because the fulfillment paths differ.

Source of truth: the browser owns cart intent; product definitions/catalog and `piece_state` own validity and availability. Failure mode: stale browser state is caught by server validation/reservation, not trusted.

### 2. Checkout begins and delivery is collected

`src/components/shop/CartView.tsx` collects contact and delivery data before creating a Stripe object. Ceramics may use InPost locker, courier, or pickup; prints use a postal address and courier-style delivery. Locker selection comes from `GeowidgetPicker.tsx`. The client emits `begin_checkout`, generates/reuses an `attemptId`, and POSTs to `/api/checkout`.

Source of truth: server validation in `validateCart()` and `validateDelivery()`. A future wallet must not replace the locker identifier, print shipping rules, consent state, or the application's delivery fields.

### 3. Reserve inventory and create the Stripe object

`src/app/api/checkout/route.ts`:

1. determines currency from locale and `currency_pref`;
2. resolves and prices items server-side;
3. rejects mixed/private-sale-plus-print carts;
4. resolves usable print assets before creating money or reservations;
5. obtains an idempotent internal order for `attemptId`;
6. reserves ceramics with `reserve_pieces()` or `reserve_private_sale_pieces()` for 15 minutes;
7. creates a Stripe PaymentIntent using idempotency key `pi_create_<orderId>`;
8. persists `orders` and `order_items`;
9. returns `client_secret`.

The PaymentIntent includes amount/currency and application metadata. It uses a hard-coded `STRIPE_PMC_ID` payment-method configuration. The value is account/environment-specific. In the connected local test account, retrieving that configuration returned `resource_missing`; the account's default test configuration was a different object. A commit on another branch (`e8e8f91`) externalizes this value, but that change is not in the audited revision.

Reservation is database-transactional within the RPC. PaymentIntent creation and subsequent order/item persistence cannot share a transaction with Stripe, so the route uses Stripe idempotency plus compensating PaymentIntent cancellation/inventory release on persistence failure. The internal order/attempt uniqueness prevents parallel POSTs from creating two valid checkout attempts.

### 4. Submit payment

After the API returns a secret, `CartView` mounts Stripe `Elements`. `src/components/shop/CheckoutForm.tsx` renders one `PaymentElement` and calls `stripe.confirmPayment({ elements, confirmParams: { return_url } })`. No Express Checkout Element is mounted. There is no Checkout Session.

Payment method availability is controlled by the referenced Stripe payment-method configuration plus Stripe/browser eligibility. The repository does not disable Link or wallets in Element options. Payment Element can therefore surface Link and eligible wallet methods itself. The application does not pass the custom contact/address form through Stripe Address Element, so Link cannot autofill those custom delivery fields merely by being enabled in Payment Element.

### 5. Return to the site

The localized `/koszyk/return` UI retrieves the PaymentIntent once with `stripe.retrievePaymentIntent()` and maps `succeeded`, processing, and failure states. It clears the cart and emits a browser `purchase` only on success, deduplicated in session storage by PaymentIntent. It does not mutate orders, stock, email, or fulfillment.

Source of truth: Stripe webhook plus internal database, not the return page. This is correct for redirects, closed tabs, and asynchronous completion.

### 6. Receive and authenticate webhook

`src/app/api/stripe/webhook/route.ts` reads `await req.text()` before parsing, obtains `stripe-signature`, and calls `constructEventAsync()` with `STRIPE_WEBHOOK_SECRET`. This preserves the exact raw body and is compatible with the Workers fetch runtime. Missing/invalid signatures return 400. Unknown event types are acknowledged and ignored.

The endpoint receives:

- `payment_intent.succeeded`;
- `payment_intent.payment_failed`;
- `payment_intent.canceled`;
- `charge.refunded`;
- `charge.dispute.closed`.

The connected **test-mode** webhook endpoint was enabled at the production URL, subscribed to those exact events, and used API version `2026-05-27.dahlia`.

### 7. Paid order, inventory, communication, and fulfillment

`handleStripeEvent()` in `src/lib/webhook.ts` routes a success to:

1. `markPaid()` — order lookup by PaymentIntent, pending-to-paid compare-and-set, reserved-to-sold ceramic update, private-sale consumption, and exactly-counted ceramic fulfillment;
2. `trackPurchase()` — consent-gated server GA4 Measurement Protocol and Meta CAPI with a deterministic event ID shared with the browser;
3. `ensureInvoiced()` — Stripe Customer/Invoice creation, finalized and marked paid out of band, with Stripe idempotency keys and `invoiced_at` guard;
4. fulfillment — InPost shipment creation for ceramics or durable `fulfilment_jobs` enqueue for prints.

If a late success cannot sell the expected number of reserved ceramics, the code issues an idempotent refund and changes/releases the order rather than fulfilling an item now owned by another order. That is an important one-of-one safety net.

Email claims use `confirmation_email_sent_at` and studio notification claim fields to reduce duplicates. Failed customer/studio sends are retried locally, claims are released on failure, and Sentry records the failure, but the Stripe webhook is still acknowledged. Recovery therefore depends on replay/reconciliation rather than automatic Stripe retry for email alone.

InPost retryable failures throw so Stripe retries the event. Nonretryable fulfillment failures are recorded/reported. Print submission is separated by a durable database job, Cloudflare Queue retries, and a DLQ. Unique job/idempotency constraints prevent duplicate active submissions.

### 8. Failure, cancellation, expiry, refund, and dispute

- `payment_intent.payment_failed` and `.canceled` call `releaseHold()` for pending orders.
- The 15-minute inventory reservation is distinct from the one-hour abandoned-order cron. `expirePendingOrders()` cancels the PaymentIntent before releasing the order/reservation; it refuses to release a PaymentIntent that is already succeeded or still processing.
- Full `charge.refunded` events call `releaseSale()` and relist ceramics. Partial refunds do not relist by design.
- Lost `charge.dispute.closed` events also call `releaseSale()`.
- Admin refund is exposed through dependency-injected admin actions and `scripts/orders-cli.ts`, with Stripe idempotency and print-fulfillment cancellation/escalation.

## Robustness assessment

### Correct and worth keeping

- exact raw-body signature verification;
- server-authoritative amounts and products;
- row-locking reservation RPC with deterministic lock order;
- same-order reservation idempotency and expired-reservation takeover;
- showroom and missing-product conflict protection;
- unique PaymentIntent association and stable checkout attempt;
- idempotent Stripe creation/refund/invoice operations;
- late-payment under-fulfillment refund rather than oversell;
- webhook-authoritative fulfillment;
- guarded email and fulfillment side effects;
- durable print queue with DLQ;
- cron cancellation before reservation release;
- full-refund-only relisting.

### Gaps

1. **Out-of-order terminal events.** `releaseSale()` only acts on a paid order. A refund/lost-dispute event received while the internal order is pending becomes a successful no-op. A later success can mark paid and fulfill. Stripe does not guarantee event order.
2. **Non-atomic refund release.** `releaseSale()` first updates `orders.status` from paid to refunded, then separately updates `piece_state`. If the second request fails, Stripe retries; the compare-and-set no longer matches because the order is already refunded, so the inventory release is not resumed.
3. **No Stripe event ledger.** There is no durable unique `event.id` record with processing state/error/attempt. The existing `webhook_events` table belongs to Prodigi callbacks. Side-effect-local guards are valuable, but they do not provide event-level visibility or a general resume point.
4. **Swallowed post-payment failures.** Invoice and email failures intentionally return 200. This avoids retrying unrelated successful effects but requires a clearly owned reconciler and alert/runbook, which was not found for Stripe operations.
5. **Configuration portability.** The hard-coded payment-method configuration is not portable across Stripe accounts/modes. No payment-method domains existed in the connected test account.
6. **No wallet/Link measurement.** There are no wallet, Link, or Express-specific tests or funnel reporting proving that an additional express surface addresses a demonstrated bottleneck.

“Exactly once” is not claimed. Stripe delivers at least once. The present system makes many individual effects effectively idempotent, but the gaps above prevent the whole event workflow from being called convergent under every ordering/partial-failure scenario.

## Live Supabase evidence

### Access method and limitation

Supabase MCP was unavailable: no Supabase MCP tools/resources were installed, and direct MCP discovery required authentication that was not available. Restoration/authentication was attempted. The repository was linked to a Supabase project, so the fallback audit used:

- `supabase migration list --linked` for applied history;
- a temporary `supabase migration fetch` outside the repository to inspect remote-only migration text;
- read-only service-role Data API aggregate queries without outputting keys or customer-level PII.

The CLI database dump/introspection path could not run because Docker was unavailable. Therefore live policies, triggers, indexes, and constraints below are reconciled from the migration set rather than independently enumerated by MCP. This does not satisfy the requested MCP source-of-truth standard and remains a blocker for an implementation-ready database review.

### Representative aggregate state

| Object | Safe live aggregate observed |
| --- | --- |
| `orders` | 41 total: 28 paid, 11 expired, 2 failed; 39 PLN, 2 EUR; 36 InPost, 5 pickup, 0 Prodigi |
| `order_items` | 114 total; all had `variant_id` null, so no live print-order rows were observed |
| `piece_state` | 126 rows: 120 sold, 6 available, 0 reserved; 120 showroom, 6 not showroom |
| `private_sales` | 2 rows |
| `fulfilment_jobs` | 0 rows |
| `prodigi_orders` | 0 rows |
| `webhook_events` | 0 rows; this table is for provider callbacks and is not used by Stripe |
| `products` | 129: 125 ceramics, 4 prints; 128 active, 1 draft |
| `product_variants` | 194: 173 active, 21 inactive |
| `pod_variants` | 9 active |
| print assets/assignments | 7 ready assets; 21 assignments |

No customer contact values, addresses, tokens, secrets, or payment identifiers were printed during this audit.

### Relevant schema and invariants from applied migrations

- `piece_state`: primary key `product_id`; enum-like status `available|reserved|sold`; `reserved_until`, `order_id`, showroom protection; reservation RPCs lock rows.
- `orders`: unique non-null `payment_intent_id`; status includes pending/paid/failed/expired/refunded; totals in integer minor units; contact/delivery/marketing JSON; fulfillment and email/invoice claim columns; optional private-sale relation.
- `order_items`: internal row key, order FK, product or print variant data; partial unique ceramic line per `(order_id, product_id)` where no variant is present.
- `private_sales`: token and exact product set; partial unique rule prevents more than one paid order consuming a sale.
- `fulfilment_jobs`: unique idempotency key and one active job per order; associated `prodigi_orders` persistence.
- `webhook_events`: unique `(provider, provider_event_id)`, currently used by Prodigi callback handling rather than Stripe.
- RLS is enabled on server-owned operational tables in migrations; application access uses the service role. No broad client write path was found.
- `reserve_pieces()` and `reserve_private_sale_pieces()` use locks and exact conflict results to prevent concurrent one-of-one sales.

### Schema drift

All 37 local migrations were reported applied to the linked project. The live project also has two **remote-only** migrations:

- `20260717120000_guarded_product_status.sql`;
- `20260717192143_harden_guarded_product_status.sql`.

They create/harden `update_product_status_guarded(text,text,text)`, lock product/variant/asset state, gate print readiness, write an audit log, revoke execution from public/anonymous/authenticated roles, and grant it to `service_role`. This drift is not a Stripe defect, but it makes the repository an incomplete migration source of truth. Fetch and review these migrations into version control before adding a Stripe event-processing migration.

## Stripe SDK/API version truth

`src/lib/stripe.ts` creates a Stripe client with the fetch HTTP client and does not pass `apiVersion`. The installed SDK's `apiVersion.js` is `2026-05-27.dahlia`. With modern stripe-node, the SDK sends the API version current for that SDK release; it does not silently use the account default. The source comment and repository guidance saying “account-default” are inaccurate. The connected test webhook endpoint was explicitly pinned to `2026-05-27.dahlia`, so payload and SDK types presently align there. Live endpoint alignment was not verified.

## Existing test coverage

The current unit baseline passes: **110 files, 1,207 tests** on 2026-07-18.

Coverage found includes:

- checkout validation, rate limiting, attempt concurrency, Stripe idempotency, print shipping/assets, mixed-cart rejection, and rollback;
- webhook signature routing, success/failure/cancellation/refund/dispute paths, repeat calls, emails, invoicing, shipment creation, order expiry, queue retries/DLQ;
- pgTAP tests for reservation/private-sale/fulfillment idempotency;
- Playwright CI-safe checkout conflicts and print configurator;
- opt-in destructive Stripe decline, ceramic purchase, and print purchase/fulfillment polling.

Material missing cases are enumerated in `06-test-plan.md`: refund-before-success ordering, partial database failure after the order becomes refunded, a Stripe event-ledger lease/resume contract, replay recovery, wallet/Link/Express eligibility and fallback, and any retained Payment Link integration.
