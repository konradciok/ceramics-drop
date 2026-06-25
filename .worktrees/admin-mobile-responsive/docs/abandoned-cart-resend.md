# Abandoned-checkout recovery (Resend Automation)

When a shopper clicks **Pay** but never completes payment, we email them a
localised "your cart is waiting" reminder ~30 minutes later. The flow is driven
by **Resend Events + Automations**, triggered server-side from the existing
checkout and webhook paths — **not** from GTM/client analytics (GTM has no email
address and can't safely hold a Resend key).

## Why the checkout API, not `add_to_cart`

| Fact | Implication |
|------|-------------|
| Cart is `localStorage` only (`acc_cart_v1`), no server sync | The server never sees a bare "add to cart" |
| The email is first known when the user fills the checkout form | `add_to_cart` has no address to send to |
| A successful `POST /api/checkout` writes an `orders` row (`pending`) with email + locale | This is the earliest point with everything we need |

So the trigger is **`cart.checkout_started`**, fired right after the order +
items persist (before `client_secret` is returned). Recovery for users who add
to cart but never reach checkout is **out of scope** (no email captured).

## Architecture

```
[Click Pay] → POST /api/checkout (order pending persisted)
    └─ ctx.waitUntil( sendCheckoutStartedEvent ) ──► Resend event: cart.checkout_started
                                                       { order_id, locale, currency, total_minor,
                                                         cart_url, first_name, subject, main_content_html }

[Stripe payment_intent.succeeded] → markPaid (newSale)
    └─ await sendPurchasedEvent ──────────────────► Resend event: cart.purchased { order_id }

Resend Automation "Abandoned checkout — 30m":
    trigger cart.checkout_started
      → wait_for_event cart.purchased, timeout 30 min
          ├─ event_received → STOP (they paid; no email)
          └─ timeout       → condition on event.locale
                               pl → send "Twój koszyk czeka"
                               en → send "Your cart is waiting"
                               es → send "Tu cesta te espera"
                             (template `abandoned-checkout`, MAIN_CONTENT = event.main_content_html)
```

The wait is **contact-scoped**: `cart.purchased` cancels the recovery for that
buyer's email. Both events must carry the **same email** (they do — both read the
order's `email`).

### Why 30 minutes (not 1 hour)

`worker.ts` runs a cron that expires `pending` orders older than **1 hour**: it
cancels the Stripe PaymentIntent and frees the reserved pieces. The reservation
lock itself (`reserve_pieces`) is only **15 min**. Firing at 30 min sends the
reminder while the order is still live, before the cron tears it down. (Even past
1 h the link still works — the cart is `localStorage` and freed pieces reappear
as available — but 30 min recovers the sale earlier.)

### Why the subject is static per-locale (not from the event)

Resend's `send_email` step resolves **`subject` as a literal string only** — it
does **not** substitute `{ var: event.* }` into the subject (verified: a var
subject returns `422 "subject must be a string"`). So the automation branches on
`event.locale` and uses three hard-coded subjects. The email **body** is fully
localised in code and passed through `event.main_content_html` →
`{{{MAIN_CONTENT}}}`.

⚠️ The three subjects are duplicated: once in the automation config, once in
`AUTOMATION_SUBJECTS` in `src/lib/resend-events.ts`. The `subject drift guard`
unit test pins the builder subjects to `AUTOMATION_SUBJECTS`; if you change a
subject, update **both** the constant and the automation step.

## Event contract

### `cart.checkout_started` — fired on successful checkout

| Field | Type | Notes |
|-------|------|-------|
| `order_id` | string | `orders.id` |
| `locale` | string | `pl` \| `en` \| `es` |
| `currency` | string | `pln` \| `eur` |
| `total_minor` | number | grosze / euro-cents (analytics/debug only) |
| `cart_url` | string | absolute, locale-aware `/koszyk` |
| `first_name` | string | raw; `''` when absent |
| `subject` | string | localised; **automation ignores it** (uses its own static subject) — kept for parity/debug |
| `main_content_html` | string | rendered, escaped inner HTML for `{{{MAIN_CONTENT}}}` |

### `cart.purchased` — fired on payment success

| Field | Type | Notes |
|-------|------|-------|
| `order_id` | string | `orders.id` |

Both are sent via `POST https://api.resend.com/events/send` with
`{ event, email, payload }` and `Authorization: Bearer ${RESEND_API_KEY}`. Resend
auto-creates the contact from `email` on first use.

## Code

- `src/lib/resend-events.ts` — `sendResendEvent` (the `/events/send` wrapper, 8 s
  AbortController), pure builders (`buildAbandonedCartEmail`,
  `buildCheckoutStartedPayload`, `buildPurchasedPayload`, `cartUrlForLocale`), and
  the two env-reading senders (`sendCheckoutStartedEvent`, `sendPurchasedEvent`).
- `src/lib/resend-events.test.ts` — 21 unit tests (subjects, drift guard, body,
  cart URL, payloads, endpoint + error handling).
- `src/app/api/checkout/route.ts` — fires `cart.checkout_started` via
  `ctx.waitUntil` (non-blocking, survives the response, never fails checkout).
- `src/app/api/stripe/webhook/route.ts` — fires `cart.purchased` in the `newSale`
  path, awaited + swallowed like the surrounding confirmation emails.

Failures are always logged and swallowed — a Resend hiccup never breaks checkout
or webhook fulfillment.

## Resend objects (production account)

- Events: `cart.checkout_started`, `cart.purchased`
- Template: `abandoned-checkout` (published) — same brand shell as the
  transactional templates, single `{{{MAIN_CONTENT}}}` variable
- Automation: **Abandoned checkout — 30m** (ID `019eb892-6b8b-767a-985a-7e09ab091710`)

## How to test

The automation must be **enabled** to produce runs (it ships **disabled**).

1. **Wiring / wait state** — fire a test event and confirm the run parks in
   `waiting`:
   ```
   resend send-event cart.checkout_started \
     --email you@example.com \
     --payload '{ "order_id":"test-1", "locale":"en", "main_content_html":"<p>hi</p>" }'
   resend get-automation-runs <automation-id>     # step wait_purchased → waiting
   ```
2. **Cancellation** — fire `cart.purchased { order_id: "test-1" }` for the same
   email within 30 min → the run completes with **no** email sent.
3. **Send path** — fire only `cart.checkout_started` and let the 30-min timeout
   elapse (or temporarily lower the wait) → a localised recovery email arrives;
   confirm the subject matches the locale and the CTA links to the right
   `/koszyk`.
4. **Real E2E** — add a piece → checkout → fill email → Pay → abandon (don't
   finish the PaymentElement). After the wait, the email lands. Completing payment
   before the wait elapses suppresses it.

Inspect runs with `get-automation-runs`; each step reports
`completed` / `waiting` / `skipped`.

## Risks & follow-ups

- **GDPR / consent.** This is a transactional "finish your order" nudge, but some
  jurisdictions treat cart reminders as marketing. The template has no unsubscribe
  topic wired. Confirm with the studio whether a one-reminder cart email is
  acceptable under their privacy policy; add a Resend topic + unsubscribe if you
  want an opt-out.
- **No recovery without an email** (add-to-cart-only abandoners). Would need a
  separate email-capture step on the cart page.
- **Sold-out by send time.** For one-of-a-kind pieces, a piece may sell to someone
  else before the reminder. The link still works — the cart page reconciles
  against `/api/inventory` and drops sold pieces — but the email doesn't say
  "some items are gone." Acceptable for v1.
- **Subject duplication** (see drift guard above).
