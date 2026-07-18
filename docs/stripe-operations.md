# Stripe operations runbook

Operational recovery for the Stripe payment pipeline (checkout → webhook →
fulfilment). Monitoring lives in **Stripe Workbench** (event deliveries,
retries, resend) and **Sentry** (application errors) — this repo only adds
durable order state and the commands below. Owner: studio operator
(konrad.ciok@gmail.com).

## Correlate a payment to an order

Stripe PaymentIntent (`pi_…`) ↔ `orders.payment_intent_id` (one-to-one).

```bash
npm run orders -- list --limit 20          # recent orders + status
npm run orders -- show <order-id>          # full order: items, shipment, invoice, emails
```

In Workbench, search the `pi_…` id to see every event and its delivery status.
Never paste customer PII into shared logs; the CLIs redact emails by default.

## When a webhook delivery failed (non-2xx)

Stripe retries automatically for up to 3 days. If retries are exhausted or you
need it now: Workbench → the event → **Resend**.

**Resending** `payment_intent.succeeded` **is safe.** Every effect is guarded:
order flip is a CAS (`pending→paid`), customer/studio emails claim
`*_sent_at` columns before sending, invoicing checks `invoiced_at` + Stripe
idempotency keys, InPost shipment is guarded by `inpost_shipment_id`, Prodigi
enqueue by the job idempotency key, private-sale consumption by
`consumed_at IS NULL`, and conversions dedupe on `purchase-<pi>`.

**Resending** `charge.refunded` **/** `charge.dispute.closed` **is safe.** The release
converges regardless of order and resumes a partially-completed release
(pieces still `sold`/`reserved` on a `refunded` order are finished on replay);
a replay after full completion is a no-op.

## Recovery by symptom


| Symptom                                     | Detect                                                       | Fix                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Customer confirmation email missing         | `node scripts/reconcile-orders.mjs` (preview)                | `--emails`, or `npm run orders -- resend-confirmation --confirm <id>`                         |
| Invoice missing on a paid order             | `node scripts/reconcile-orders.mjs --dry-run --invoices`     | Workbench → resend that order's `payment_intent.succeeded`                                    |
| InPost shipment stuck / label missing       | reconcile preview (`--buy` / `--labels` sections)            | `--buy` then `--labels`, or `npm run orders -- create-shipment --confirm <id>`                |
| Prodigi print job stuck                     | `npm run print-fulfilment:check-jobs`; Cloudflare Queue DLQ  | Workbench → resend the order's `payment_intent.succeeded` (re-enqueues the job idempotently); if it keeps failing, escalate to Prodigi support with the `prodigi_orders` id |
| Order refunded but piece not back in shop   | `npm run orders -- show <id>` (pieces still `sold`)          | Workbench → resend the `charge.refunded` event (release resumes)                              |
| Payment succeeded but order still `pending` | Workbench shows failed `payment_intent.succeeded` deliveries | fix the cause (check Sentry), then resend the event                                           |


## Refunds

Issue refunds from the admin panel or `npm run orders -- refund --confirm <id>`
(full refunds only — a partial refund moves money without relisting). The
`charge.refunded` webhook performs the relist; do not hand-edit `piece_state`.

## Alerts — one-time setup checklist (operator, external)

- [ ] Workbench → Webhooks → the endpoint → enable delivery-failure notifications (test AND live mode).
- [ ] Workbench → keep the endpoint API version matched to the installed `stripe` package (see AGENTS.md "API-version ritual").
- [ ] Sentry → alert rule routing `stripe_webhook_*` messages and `createOrderInvoice`/email capture exceptions to the operator email.
- [ ] Cloudflare → notification on `prodigi-fulfilment` queue DLQ depth > 0.

## See also

- `docs/orders-cli.md` — order/inventory inspection + the four admin mutations
- `docs/prodigi-cli.md` — Prodigi sandbox debugging
- `scripts/reconcile-orders.mjs` — email/shipment/invoice backfill + discovery
