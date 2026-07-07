# 01 — Refund/dispute → Prodigi cancel-or-alert (Finding 1)

> **Severity: High.** This is the only place the store loses real money today. Ship this first.
> **Effort: `high`.** **Discriminator:** `order_items.variant IS NOT NULL` = print item.

## Goal

When a **print** order is fully refunded, or loses a dispute, the corresponding Prodigi order must not keep running:

- If the Prodigi order is **still cancellable**, cancel it via the Prodigi API.
- If it is **already in production or shipped**, do not attempt to cancel — fire a Sentry alert **and** a studio email so a human absorbs/cancels it in the Prodigi dashboard.
- If the refund lands **before** the Prodigi order was ever submitted (job queued but not sent), the queued job must **not** submit.

Never silently no-op for a print order. Ceramic behaviour is unchanged.

## Why

Today `releaseSale` only flips `orders.status → refunded` and relists `piece_state` (which prints don't have). The Prodigi job keeps producing, shipping, and invoicing the studio — the customer is refunded and may also receive the product. Direct financial loss.

## Current state (verified)

- `src/app/api/stripe/webhook/route.ts`
  - `releaseSale` (~L323-346): CAS `paid → refunded`, relists sold pieces. **No print handling.** Called from `charge.refunded` (full refund only) and `charge.dispute.closed` (lost only) via `handleStripeEvent` in `src/lib/webhook.ts`.
  - `createShipment` (~L355-463) is the fulfilment router: selects `order_items(variant)`, `hasPrints = variant !== null`, `enqueueProdigi(orderId, env, ctx)`.
- `src/app/api/admin/refund/route.ts`: plain `stripe.refunds.create` — **no Prodigi handling.**
- `src/server/prodigi/client.ts` → `prodigiClient(env)` exposes **only** `postOrder`, `getOrder`, `getProduct`. **No cancel.** Base `https://api[.sandbox].prodigi.com/v4.0`, header `X-API-Key`.
- `prodigi_orders` columns: `order_id`, `prodigi_order_id` (text unique), `prodigi_status_stage` (text), `prodigi_raw_json` (jsonb).
- `src/server/fulfilment/status-map.ts` → `mapProdigiStage`: `InProgress→fulfilment_submitted`, `InProduction→in_production`, `Complete→shipped`, `Cancelled→cancelled`.
- `src/server/fulfilment/process-job.ts` → `processJob(msg, env, _ctx)`: submits to Prodigi, upserts `prodigi_orders`.
- Sentry available (`SENTRY_DSN` server); studio email via Resend to `STUDIO_NOTIFY_EMAIL` (see `src/lib/email.ts`).

## First task — verify the Prodigi API shape (do this before coding)

The cancel endpoint is `POST /v4.0/orders/{id}/actions/cancel` and availability is discoverable via `GET /v4.0/orders/{id}/actions`. **Confirm the exact request/response JSON shape** against the live reference before wiring it in — the audit flagged this as unverified:

- Reference: https://www.prodigi.com/print-api/docs/reference/ (Orders → Cancel / Actions).
- Determine: the field that reports whether cancel is available (e.g. an `actions.cancel` availability flag), the cancel response body, and the resulting order `status.stage`.
- If the reference and `getOrder(...).status.stage` already tell you cancellability, you may not need a separate actions call. Prefer the fewest calls that answer "is cancel available?".

Record what you confirmed in `PROGRESS.md`.

## Approach (you choose the exact shape)

1. **Extend the Prodigi client** (`src/server/prodigi/client.ts`) with a cancel path — e.g. `cancelOrder(prodigiOrderId)` (`POST /orders/{id}/actions/cancel`) and, if needed, `getOrderActions(prodigiOrderId)`. Reuse the existing `X-API-Key` / `baseUrl(env)` plumbing and `ProdigiError` handling.
2. **Add one shared helper** — e.g. `src/server/fulfilment/cancel-print.ts` → `cancelPrintFulfilment(orderId, env, ctx)` that:
   - loads `order_items(variant)` for the order; if **no print item** (all `variant` null) → return (ceramic order, nothing to do);
   - loads the `prodigi_orders` row for the order:
     - **no row yet** (job queued, not submitted) → mark the queued `fulfilment_jobs` row so it won't submit, or rely on the process-job guard in step 4;
     - **row present** → check cancellability (per your verified shape); if cancellable → `cancelOrder(...)` and set `prodigi_status_stage = 'cancelled'`; else → **alert** (Sentry + studio email "print refunded — cancel/absorb manually in Prodigi", include order id + `prodigi_order_id`);
   - is **idempotent**: if stage is already `cancelled`, do nothing.
3. **Wire it in** to both refund paths, after the existing status flip / refund succeeds:
   - `releaseSale` in the webhook route (covers `charge.refunded` full + `charge.dispute.closed` lost);
   - `src/app/api/admin/refund/route.ts` after `stripe.refunds.create` succeeds.
4. **Guard the queue** — in `process-job.ts`, before `postOrder`, bail if the order is no longer `paid` (refunded/failed/expired). This closes the "refund before submission" race so a cancelled-in-flight order is never sent to Prodigi. Log and mark the job accordingly.

Keep the Prodigi call best-effort relative to Stripe: a cancel/alert failure must not throw out of the webhook in a way that makes Stripe retry the refund event forever — log/alert and move on (mirror the existing swallow-and-200 pattern for non-retryable side-effects).

## Acceptance criteria

- [ ] Print order, Prodigi order cancellable → `cancelOrder` called once; `prodigi_status_stage → 'cancelled'`; **no** alert.
- [ ] Print order, Prodigi order already `shipped`/`Complete` → `cancelOrder` **not** called; Sentry alert **and** studio email fired, both naming the order + `prodigi_order_id`.
- [ ] Print order refunded before submission (queued job, no `prodigi_orders` row) → `process-job` does **not** call `postOrder`; no Prodigi order is created.
- [ ] Ceramic order refunded → **no** Prodigi calls; existing `piece_state` relist unchanged.
- [ ] `charge.dispute.closed` with `status='lost'` for a print → same handling as a refund.
- [ ] Idempotent: a second `releaseSale`/refund for the same order does **not** double-cancel or double-alert.

## Tests (add these)

- `src/app/api/stripe/webhook/route.test.ts`: cancellable-print, shipped-print (alert), ceramic (no Prodigi), dispute-lost-print, idempotency.
- New `src/server/fulfilment/cancel-print.test.ts` (mock the Prodigi client): cancellable → cancel; shipped → alert; no-row → guard; already-cancelled → no-op.
- `src/server/fulfilment/process-job.test.ts` (extend): non-`paid` order → no `postOrder`.

Run: `npx vitest run src/app/api/stripe/webhook/route.test.ts src/server/fulfilment/cancel-print.test.ts src/server/fulfilment/process-job.test.ts`, then `npm run lint && npm run build`.

## Boundaries

- Do **not** touch the ceramic relist logic, `markPaid`, or `releaseHold`.
- Do **not** build a generic retry/cancellation framework. One helper, two call sites, one queue guard.
- Do **not** add a partial-refund path — scope is full refund + lost dispute (matches the existing `releaseSale` triggers).
- Alerts are best-effort side effects — a failed alert must not fail the refund.
