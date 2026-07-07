# Ceramics ⇄ prints separation — execution progress

One entry per domain: decisions, files touched, tests, surprises. Consult before starting each domain.

## 01 — Refund lifecycle (DONE)

**Prodigi API shape (verified against https://www.prodigi.com/print-api/docs/reference/):**
- `GET /v4.0/orders/{id}/actions` → `{ outcome: "Ok", cancel: { isAvailable: "Yes"|"No" }, ... }`
- `POST /v4.0/orders/{id}/actions/cancel` → `{ outcome: "Cancelled"|"FailedToCancel"|"ActionNotAvailable", order: {...} }` — order stages are `InProgress`/`Complete`/`Cancelled`; cancel only available before fulfilment.
- Implementation checks `actions.cancel.isAvailable === 'Yes'` first (so `cancelOrder` is never called on a shipped order), then requires `outcome === 'Cancelled'`; any other outcome falls through to the alert.

**Decisions:**
- `prodigi_status_stage` keeps **raw Prodigi casing** (`'Cancelled'`, not `'cancelled'`) — matches processJob (`'InProgress'`) and the callback upsert convention.
- Alert idempotency across the two call sites (admin refund + webhook releaseSale) needed a claim column → migration `20260707120000_prodigi_orders_cancel_alert.sql` adds `prodigi_orders.cancel_alerted_at`; CAS-claimed before alerting (same pattern as `*_email_sent_at`).
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

## 04 — Emails (DONE)

**Decisions:**
- F7: webhook studio caller selects `variant` and maps print items to `{ ...variant, prodigiSku }` via `PRODIGI_SKU_MAP[variantKey(...)]` (fallback `'—'` for an unknown key — can't happen for a validated order). The `.mjs` reconcile script can't import TS, so it derives the SKU from the map's structure (`GLOBAL-{FAP|CFP|CFPM}-{inches}`) with a `ponytail:` sync note, and renders a PL-only variant line.
- F5: `buildOrderConfirmationEmail`/`emailOrderConfirmationToCustomer` take `kind?: 'ceramic' | 'print'` (default ceramic → all existing callers unchanged). New `I18N_ORDER_CONFIRMATION_PRINT` map (pl/en/es/de): Prodigi on-demand production, 2–5 business days, EU/UK courier, tracking email promised — no InPost/Poland/locker text. Webhook derives kind from the (now variant-aware) item rows: print copy only when ALL items are prints.
- F6: new `buildPrintShippingConfirmation` + `emailPrintShippingConfirmationToCustomer` — reuses the existing 4-locale `I18N` shipping strings; carrier tracking number + URL button; **no returns block** (prints not returnable per 03) and no locker language. Sent from `handleProdigiCallback` when `localStatus === 'shipped'`, claim-once via new `prodigi_orders.shipping_email_sent_at` (migration `20260707130000`), claim released (CAS on own timestamp) on send failure so a replayed callback retries. Best-effort — callback still completes.
- Prodigi `shipments[]` shape verified against the docs: `{ carrier: { name, service }, tracking: { number, url }, dispatchDate, status }`; added `ProdigiShipment` to types.
- Route test needed `@/server/fulfilment/enqueue` mocked once print items started flowing through the succeeded path.

**Known gap (out of plan scope):** `reconcile-orders.mjs --confirmation` resends still use the ceramic July copy for print orders (plan's F5 scope was the webhook caller only). Flag if print reconciles become a thing.

**Files:** `src/lib/email.ts`, `src/app/api/stripe/webhook/route.ts`, `src/server/prodigi/callbacks.ts`, `src/server/prodigi/types.ts`, `scripts/reconcile-orders.mjs`, migration `20260707130000_prodigi_orders_shipping_email.sql`.

**Tests:** email.test.ts (+7: studio SKU render, print copy ×4 locales, ceramic default, print shipping builder ×3), webhook route.test.ts (+2: print studio payload + print kind; ceramic kind), new `callbacks.test.ts` (5: send-once, claim-taken replay, done-event replay, non-shipped stage, claim release on failure). Full suite 661, lint clean, script `node --check` OK, build green.
