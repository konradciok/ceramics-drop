# 03 — Returns: print-only orders are not eligible (Finding 4)

> **Severity: Medium.** Fast win — essentially a one-condition guard + a test.
> **Effort: `medium`.** **Discriminator:** `order_items.variant IS NOT NULL` = print item.

## Goal

`createOrderReturn` must return `not_eligible` for a **print-only** order. A print is shipped by Prodigi (potentially to another EU country); building an InPost locker return with the customer as sender to the studio's paczkomat is nonsensical and costs a wasted label + a confusing return-label email. POD defect handling stays a manual/support path (out of scope here).

## Decision context

Per the settled decisions in `00-master.md`: prints are **not** returnable through the ceramic InPost flow. This is a guard, not a new return channel.

## Current state (verified)

- `src/lib/return.ts` → `createOrderReturn(orderId, deps): Promise<CreateReturnResult>` (~L44-69).
  - Eligibility today: `!order → order_not_found`; `status !== 'paid' → not_eligible`; `delivery_method === 'odbior' → not_eligible`; `inpost_return_shipment_id` set → `already_returned`; payload-build throw → `not_eligible`.
  - Result shape: `{ ok: true, ... } | { ok: false, reason: 'order_not_found' | 'not_eligible' | 'already_returned' }`.
  - Operates purely on the order row via injected `loadOrder`. **Does not look at `order_items` / `variant`.**
- `POST /api/returns` wires the deps into `createOrderReturn`.

## Approach

Add a "has at least one ceramic line item" check to the eligibility ladder. Keep the dependency-injection style the module already uses:

- Extend `CreateReturnDeps` with a small dep — e.g. `hasCeramicItems(orderId): Promise<boolean>` (queries `order_items` where `variant IS NULL`, `count > 0`) — and wire it in `/api/returns` with `getSupabaseAdmin()`, mirroring `countCeramicOrderItems` in `src/lib/fulfillment.ts`.
- In `createOrderReturn`, after the `status`/`odbior`/`already_returned` checks, if `!(await hasCeramicItems(orderId))` → return `{ ok: false, reason: 'not_eligible' }`.

*(If `05` shipped first, you may read `orders.fulfilment_type !== 'inpost'` instead of a new dep — either is fine.)*

## Acceptance criteria

- [ ] Print-only paid order → `createOrderReturn` returns `{ ok: false, reason: 'not_eligible' }`; no ShipX return call.
- [ ] Ceramic order → unchanged (still eligible, existing tests still pass).
- [ ] A (defensive) mixed order that contains a ceramic item → still eligible on ceramic grounds.
- [ ] `POST /api/returns` passes the new dep; a print-only order gets a clean "not eligible" response.

## Tests

- `src/lib/return.test.ts` (extend the 7 existing): print-only → `not_eligible`; ceramic still eligible; mixed-with-ceramic still eligible.

Run: `npx vitest run src/lib/return.test.ts`, then `npm run lint && npm run build`.

## Boundaries

- Do **not** design a print-return channel here (that was explicitly deferred).
- Do not change the existing ceramic eligibility rules or the `already_returned` idempotency.
