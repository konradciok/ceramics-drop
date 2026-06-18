# Admin fulfillment queue — design spec

**Date:** 2026-06-18  
**Branch:** `main` (admin panel restored locally from `codex/product-reference-catalog`)  
**Status:** Approved design, ready for implementation plan

## Goal

Give Anna a **single packing-session screen** in the local Studio Admin that replaces
context-switching across Stripe, Supabase, and email (pain **D**), and supports **batch
packing + label printing** in one sitting (pain **A**).

The admin stays **local-only** (no auth, not deployed). This feature adds a fulfillment
workflow on top of the existing read-heavy dashboard.

## Context (current admin)

| Area | Today |
|---|---|
| Overview KPI | `awaitingFulfillment` counts paid orders with no `inpost_shipment_id` (excludes `odbior`) |
| Orders | Filter/search + detail page with Stripe/InPost enrichment |
| Actions | Refund, resend confirmation, label PDF (if shipment exists), release reservation |
| Gap | No dedicated queue; blocked shipments (webhook `createShipment` failure) have no retry UI |

Fulfillment is webhook-driven today: `payment_intent.succeeded` → `markPaid` → `ensureInvoiced`
→ `createOrderShipment` (idempotent via `inpost_shipment_id`). Labels are fetched on demand via
`GET /api/admin/label`.

## Decisions (locked)

| Topic | Decision |
|---|---|
| Primary UX | **Fulfillment Queue** at `/admin/fulfillment` + **wizard-lite** drill-down at `/admin/fulfillment/[id]` |
| Device target | **Laptop at desk** (browser + printer nearby). No mobile layout in v1. |
| Persistence | **No new DB columns** in v1. Pipeline stages are computed from existing `orders` fields. |
| Shipment retry | New `POST /api/admin/create-shipment` wrapping existing `createOrderShipment()` — same idempotency as webhook |
| Batch print | **Out of scope v1** — one label per click/tab is acceptable; revisit if batch size grows |
| "Packed" checkbox | **Out of scope v1** — pipeline pills + InPost `delivery_status` are sufficient |
| Auth | Unchanged — local-only admin, no login layer |

## Fulfillment stages (computed)

Stages are derived per order; not stored.

| Stage | Condition | User-facing label |
|---|---|---|
| `blocked` | `status = paid`, `needsShipment(delivery_method)`, `inpost_shipment_id IS NULL` | **Zablokowane** — przesyłka nie utworzona |
| `ready` | `status = paid`, `inpost_shipment_id IS NOT NULL`, no meaningful `delivery_status` yet | **Do zapakowania** |
| `in_transit` | `delivery_status` set (InPost webhook) | **W drodze** |
| `pickup` | `status = paid`, `delivery_method = odbior` | **Odbiór osobisty** |

`needsShipment()` already exists in `src/lib/shipx.ts` (`paczkomat` + `kurier` → true;
`odbior` → false).

**Queue membership (v1):** paid orders where:
- ship methods: stage is `blocked` or `ready` (action still needed), OR
- `odbior`: always listed while paid (studio coordinates pickup manually).

Orders already `in_transit` drop off the default queue but remain reachable via order detail.

## Architecture

```
/admin/fulfillment                    /admin/fulfillment/[id]
  │ listFulfillmentQueue()              │ getFulfillmentOrder(id)
  │ group: paczkomat | kurier | odbior  │ prev/next ids in queue
  │ row → wizard-lite link              │
  ▼                                     ▼
src/lib/admin/fulfillment.ts     OrderActions (fulfillment subset)
  │ compute stage + product refs          │ Drukuj etykietę → GET /api/admin/label
  │                                       │ Utwórz przesyłkę → POST /api/admin/create-shipment
  ▼                                       │ ← → queue navigation
adminSupabase() + productRef()            ▼
                                     createOrderShipment() (existing, idempotent)
```

## UI: Fulfillment Queue (`/admin/fulfillment`)

**Nav:** add **Wysyłka** link in `AdminNav.tsx` (after Przegląd).

**Header:** title + counter, e.g. *"4 do zapakowania"* (blocked + ready + pickup pending).

**Three sections** (tabs or stacked headings — implementer's choice; tabs preferred on laptop):

1. **Paczkomat** — `delivery_method = paczkomat`
2. **Kurier** — `delivery_method = kurier`
3. **Odbiór osobisty** — `delivery_method = odbior`

**Each row:**

| Column | Content |
|---|---|
| Order | Short UUID link → wizard-lite |
| Paid | `paid_at` or `created_at` |
| Pieces | Thumbnails + `productRef` labels |
| Customer | Name, phone |
| Delivery | Paczkomat code or address one-liner |
| Status | Pipeline pill (computed stage) |
| Action | Context button: **Utwórz przesyłkę** (blocked) or **Drukuj etykietę** (ready) |

**Sort:** oldest paid first (FIFO).

**Empty state:** *"Brak zamówień do wysyłki"* when queue is empty.

## UI: Wizard-lite (`/admin/fulfillment/[id]`)

Two-column laptop layout:

- **Left:** large piece images, names, product ids (packing reference)
- **Right:** delivery card, customer contact (`PhoneLink`), pipeline timeline, action buttons

**Actions** (subset of existing `OrderActions`, fulfillment-focused):

- **Drukuj etykietę** — `window.open('/api/admin/label?orderId=…')` (only when `inpost_shipment_id` set)
- **Utwórz przesyłkę** — `POST /api/admin/create-shipment` (only when `blocked`)
- **← Poprzednie / Następne →** — walk FIFO queue; show *"2 z 4"*

**Keyboard:** `ArrowLeft` / `ArrowRight` for prev/next (client component wrapper).

**Back link:** ← Wysyłka

## API: `POST /api/admin/create-shipment`

Local-only route, same pattern as existing admin POST routes (`refund`, `release-reservation`).

**Body:** `{ orderId: string }` (uuid) — reuse `parseOrderIdBody`.

**Behaviour:**

1. Load order; 404 if missing.
2. 409 if `status !== 'paid'`.
3. 409 if `!needsShipment(delivery_method)` (odbior).
4. Call `createOrderShipment(order.payment_intent_id, deps)` with admin-wired deps
   (mirror `src/app/api/stripe/webhook/route.ts` shipment wiring).
5. Return `{ message: 'Przesyłka utworzona.' }` or existing shipment message if idempotent no-op.

**Idempotency:** guarded by `inpost_shipment_id` inside `createOrderShipment` — safe to retry.

## Data layer: `src/lib/admin/fulfillment.ts`

New module (keeps `data.ts` from growing further):

```ts
export type FulfillmentStage = 'blocked' | 'ready' | 'in_transit' | 'pickup';

export type FulfillmentOrder = AdminOrder & {
  stage: FulfillmentStage;
  itemsEnriched: Array<{ product_id: string; unit_price: number; ref: ProductRef }>;
};

export function computeFulfillmentStage(order: AdminOrder): FulfillmentStage;
export async function listFulfillmentQueue(): Promise<FulfillmentOrder[]>;
export async function getFulfillmentOrder(id: string): Promise<FulfillmentOrder | null>;
export function fulfillmentQueueIndex(queue: FulfillmentOrder[], id: string): { index: number; total: number; prevId: string | null; nextId: string | null };
```

`listFulfillmentQueue()` loads paid orders with items (`listOrders({ status: 'paid' }, { withItems: true })`),
enriches, filters to queue membership, sorts FIFO.

## Error handling

| Failure | UX |
|---|---|
| ShipX create fails | Inline error with API message; order stays **blocked** |
| Label PDF fetch fails | Same as existing label route — show error toast/message |
| Order not paid | 409 from API; button hidden in UI |
| Stripe unavailable on detail | N/A for fulfillment queue (no Stripe call on list) |

## Testing

| Test | File |
|---|---|
| `computeFulfillmentStage` — all four stages + edge cases | `src/lib/admin/fulfillment.test.ts` |
| Queue filter/sort (FIFO, excludes in_transit from default queue) | same |
| `create-shipment` route — happy path, 409 not paid, idempotent | `src/app/api/admin/create-shipment/route.test.ts` |

## Out of scope (v1)

- Auth / deploy hardening
- `packed_at` column or manual checklist persistence
- Batch "print all labels"
- Mobile / tablet layout
- Private-sale minting UI (separate ROI item)
- GBP revenue on overview (unrelated)

## Success criteria

1. Anna can open `/admin/fulfillment` and see all orders needing packing without opening Stripe or Supabase.
2. A blocked order (paid, no shipment) can be unblocked via **Utwórz przesyłkę** without Stripe Dashboard.
3. Wizard-lite shows piece photos large enough to pack from; prev/next walks the queue in order.
4. Existing admin routes (`label`, `refund`, etc.) remain unchanged.
