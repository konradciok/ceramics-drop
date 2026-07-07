# Ceramics ⇄ prints separation — execution progress

One entry per domain: decisions, files touched, tests, surprises. Consult before starting each domain.

## 01 — Refund lifecycle (DONE)

**Prodigi API shape (verified against https://www.prodigi.com/print-api/docs/reference/):**
- `GET /v4.0/orders/{id}/actions` → `{ outcome: "Ok", cancel: { isAvailable: "Yes"|"No" }, ... }`
- `POST /v4.0/orders/{id}/actions/cancel` → `{ outcome: "Cancelled"|"FailedToCancel"|"ActionNotAvailable", order: {...} }` — order stages are `InProgress`/`Complete`/`Cancelled`; cancel only available before fulfilment.
- Implementation checks `actions.cancel.isAvailable === 'Yes'` first (so `cancelOrder` is never called on a shipped order), then requires `outcome === 'Cancelled'`; any other outcome falls through to the alert.

**Decisions:**
- `prodigi_status_stage` keeps **raw Prodigi casing** (`'Cancelled'`, not `'cancelled'`) — matches processJob (`'InProgress'`) and the callback upsert convention.
- Alert idempotency across the two call sites (admin refund + webhook releaseSale) needed a claim column → migration `20260707120000_prodigi_orders_cancel_alert.sql` adds `prodigi_orders.cancel_alerted_at`; CAS-claimed before alerting (same pattern as `*_email_sent_at`). **Applied to production** (`20260707102056` via Supabase MCP, 2026-07-07).
- Studio alert email is Polish-only, matching the existing studio email convention (label/new-order emails).
- Helper never throws (Sentry captures every failure path) so a Prodigi hiccup can't 5xx the refund webhook into a retry loop.

**Surprise:** `process-job.ts` already had the "order not paid → failed_action_required" guard (plan step 4) — it predates this work. Only strengthened its test to assert `postOrder` is never called.

**Files:** `src/server/prodigi/types.ts` (+2 response types), `src/server/prodigi/client.ts` (+`getOrderActions`, `cancelOrder`), `src/server/fulfilment/cancel-print.ts` (new helper), `src/lib/email.ts` (+`buildPrintRefundAlertEmail`/`emailPrintRefundAlertToStudio`), `src/app/api/stripe/webhook/route.ts` (releaseSale wire-in after CAS), `src/app/api/admin/refund/route.ts` (wire-in after refund create), migration above.

**Tests:** `src/server/fulfilment/cancel-print.test.ts` (10 new), webhook `route.test.ts` (+5: full refund / replay / partial / dispute lost / dispute won), `process-job.test.ts` (+1 assertion). Full suite 637 green, lint clean, build green.

**Note:** a stale `.next` dir in the worktree made `next build` fail with a workStore invariant — `rm -rf .next` fixed it; not related to any code change.

## 03 — Returns guard (DONE)

**Decision:** kept the DI style — new `CreateReturnDeps.hasCeramicItems(orderId)` dep, checked after the `already_returned` rung of the eligibility ladder. Route wires it via the existing `countCeramicOrderItems` (`variant IS NULL`); a count error **throws** (→ 500) rather than reading as "no ceramics", so a DB hiccup can't 404 a legitimately returnable order.

**Files:** `src/lib/return.ts`, `src/app/api/returns/route.ts`, `src/lib/return.test.ts` (+2: print-only → `not_eligible`, mixed-with-ceramic stays eligible; the 7 existing ceramic tests pass unchanged with the dep defaulting to `true`).

**Verified:** return tests 9/9, full suite 639, lint clean, build green. No surprises.

## 02 — Admin (DONE)

**Decisions:**
- Guard (F2): 409 with a Polish human message in `error` (`…wysyłkę realizuje Prodigi, nie InPost.`) — matches the route's existing convention; the admin UI (`FulfillmentActions`) renders `data.error` directly, so a machine code would surface raw to the user. Count failure → 500, never "reads as print-only".
- Dashboard (F3): added `variant` to both `order_items` joins in `data.ts`; new `isPrintOnly()` (items non-empty && every variant non-null). New `FulfillmentStage` value `'prodigi'` returned first from `computeFulfillmentStage`; queue filter unchanged so prints drop out of the InPost queue automatically. Stage label "Prodigi (druk)" added to both STAGE_LABEL maps (Record type forces exhaustiveness); `FulfillmentActions` shows muted "Wysyłka: Prodigi" (no buttons). Skipped the nice-to-have Prodigi stage readout from `prodigi_orders` — plan's minimum bar is exclusion; revisit only if the studio asks.
- `getKpis` now joins items (was `withItems: false`) because the KPI exclusion needs the discriminator; dataset tiny, join cheap. `awaitingFulfillment` excludes print-only; print orders still count in `ordersByStatus`/revenue.

**Files:** `src/lib/admin/data.ts`, `src/lib/admin/fulfillment.ts`, `src/app/api/admin/create-shipment/route.ts`, `src/app/admin/fulfillment/page.tsx`, `src/app/admin/fulfillment/[id]/page.tsx`, `src/app/admin/fulfillment/FulfillmentActions.tsx`.

**Tests:** create-shipment route (+1 print-only 409, helper mock extended with the order_items count chain), fulfillment (+2 stage tests, +1 queue-exclusion row), new `data.test.ts` (isPrintOnly + KPI exclusion). Full suite 645, lint clean, build green.
