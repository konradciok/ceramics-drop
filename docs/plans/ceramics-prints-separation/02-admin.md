# 02 — Admin: guard create-shipment + print-aware dashboard (Findings 2, 3)

> **Severity: High (Finding 2) / Medium (Finding 3).** Finding 3 causes Finding 2: the dashboard shows print orders as forever-`blocked`, which lures the admin into creating a bogus InPost shipment for a print.
> **Effort: `high`.** **Discriminator:** `order_items.variant` (or `orders.fulfilment_type` if `05` already shipped).

## Goal

1. **Finding 2** — `POST /api/admin/create-shipment` must refuse print-only orders (no InPost shipment for something Prodigi ships).
2. **Finding 3** — the admin dashboard/KPI/queue must stop treating print orders as InPost work: they must not count toward `awaitingFulfillment`, and must not appear as `blocked` in the fulfilment queue. Show their real state from the Prodigi side.

## Current state (verified)

- `src/app/api/admin/create-shipment/route.ts` → `POST` (~L18-88): guards `status==='paid'`, `payment_intent_id` present, `isDeliveryMethod(delivery_method)`, `needsShipment(...)`. Then calls `createOrderShipment(...)`. **No ceramic/print branch** — a print order (`delivery_method='kurier'`) passes straight through.
- `src/lib/admin/data.ts`: `ORDER_COLUMNS` (~L49) joins `order_items(product_id, unit_price)` — **no `variant`**. `getKpis()` `awaitingFulfillment` (~L183): `status==='paid' && !inpost_shipment_id && delivery_method!=='odbior'` — **print-blind** (prints never get `inpost_shipment_id`).
- `src/lib/admin/fulfillment.ts`: `computeFulfillmentStage(order)` (~L24-30) → `blocked` when a shipment method has `!inpost_shipment_id`; `orderFulfillmentQueue(orders)` (~L44-50). **Print-blind.**
- `src/lib/fulfillment.ts` (non-admin) has `countCeramicOrderItems(supabase, orderId)` using `.is('variant', null)` — the only `variant`-aware helper nearby; reuse the pattern.
- Prodigi state of record: `prodigi_orders.prodigi_status_stage` and `fulfilment_jobs.status`.

## Approach

### Finding 2 — the guard (small, do first)

In `create-shipment/route.ts`, after loading the order and before `createOrderShipment`, count ceramic line items for the order (`order_items` where `variant IS NULL`, via `getSupabaseAdmin()` — same pattern as `countCeramicOrderItems`). If **zero** (print-only) → return `409` with a clear `{ error: 'print_order_no_inpost' }` (or similar) and a human message. InPost must not be called.

### Finding 3 — make the dashboard see product kind

- Add `variant` to the `order_items` select in `ORDER_COLUMNS` (and to the `OrderItem` type) so admin rows know their kind. Derive a per-order `hasPrints`/`isPrintOnly` (any `variant !== null`). *(If `05` shipped first, read `orders.fulfilment_type` instead and skip the join change.)*
- **KPI:** exclude print-only orders from `awaitingFulfillment` — that number is the InPost queue depth.
- **Queue/stage:** print-only orders must not compute to `blocked`. Give them a distinct stage (e.g. `prodigi`) sourced from `prodigi_orders.prodigi_status_stage` / `fulfilment_jobs.status`, or exclude them from `orderFulfillmentQueue` and surface them separately. Minimum bar: **they never appear as `blocked` InPost work.** Nice-to-have: a small "Prints (Prodigi)" readout showing the real stage.

Keep it minimal — the goal is "stop lying about print orders," not a full print ops console.

## Acceptance criteria

- [ ] `POST /api/admin/create-shipment` with a print-only order → `409`, `createOrderShipment` / InPost **not** invoked.
- [ ] Same route with a ceramic order → unchanged (still creates the InPost shipment).
- [ ] `getKpis().awaitingFulfillment` does **not** count print-only paid orders.
- [ ] `computeFulfillmentStage` / `orderFulfillmentQueue` never classify a print-only order as `blocked`; it is either excluded or shown with a Prodigi-sourced stage.
- [ ] Ceramic KPI/queue behaviour is byte-for-byte unchanged.

## Tests

- `src/app/api/admin/create-shipment/route.test.ts` (extend the 5 existing): "print-only order → 409, InPost not called".
- `src/lib/admin/fulfillment.test.ts` (extend the 9 existing): print-only order not in the blocked queue (or classified as `prodigi`).
- `src/lib/admin/data.test.ts` (create if absent, else extend): `awaitingFulfillment` excludes print-only orders; ceramic count unchanged.

Run: `npx vitest run src/app/api/admin/create-shipment/route.test.ts src/lib/admin/fulfillment.test.ts src/lib/admin/data.test.ts`, then `npm run lint && npm run build`.

## Boundaries

- Do not build a full Prodigi admin UI. Surface stage read-only at most.
- Do not change ceramic KPI math or the InPost queue ordering.
- Reuse the `variant IS NULL` discriminator; don't invent a new one.
