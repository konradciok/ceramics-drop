# 05 — Architecture hardening: fulfilment_type, drop dead column, private-sale guard (Findings 8, 9, 12)

> **Severity: Medium (8) / Low (9, 12).** This is the keystone: an explicit order-type column that makes the whole separation legible instead of relying on an unwritten "join `order_items.variant` and check NULL" protocol.
> **Effort: `xhigh`** — a DB migration + backfill + consumer switch. Correctness over speed.

## Goal

1. **Finding 8:** add `orders.fulfilment_type` (`'inpost' | 'prodigi' | 'pickup'`) with a CHECK, written at checkout, backfilled from existing data. Make it the explicit discriminator; switch consumers off `order_items.variant` inference where cheap.
2. **Finding 9:** drop the dead `order_items.pod_variant_id` column (settled: `PRODIGI_SKU_MAP` stays the SKU source of truth; `pod_variants` remains only the `sync-prodigi-skus` verification target).
3. **Finding 12:** add an explicit `400` guard rejecting `private_sale_token` + prints in checkout, and declare it.

## Current state (verified)

- Only CHECK on `orders` today is currency (`20260705000000_orders_currency_usd_cad.sql`). `delivery_method` is bare `text`, no CHECK; `'kurier'` means InPost for ceramics and Prodigi for prints (overloaded).
- `src/app/api/checkout/route.ts`: `hasPrints` (~L79); delivery/country/shipping already computed here — **the type is fully known at insert time.** Private-sale branch (~L156-184) reserves via `reserve_private_sale_pieces` with **no** `privateSaleToken && hasPrints` guard (relies on the RPC finding no matching `piece_state`).
- `order_items.pod_variant_id`: FK added in `20260626120001_pod_variants.sql` (~L18), **referenced nowhere** in `src/` or `scripts/` (grep-confirmed). `pod_variants` written only by `scripts/sync-prodigi-skus.ts`.

## Approach

### Finding 8 — `orders.fulfilment_type`

1. **Migration** (timestamp > `20260705000000`): add `orders.fulfilment_type text` with a CHECK `in ('inpost','prodigi','pickup')`.
   - Backfill existing rows: `pickup` where `delivery_method = 'odbior'`; `prodigi` where the order has any `order_items.variant IS NOT NULL`; else `inpost`.
   - After backfill, set `NOT NULL` (do it in the same migration after the `UPDATE`, or a follow-up — your call, but land it NOT NULL).
   - Optional: add a CHECK constraining `delivery_method` too, if it doesn't risk existing rows.
2. **Write at checkout:** in `src/app/api/checkout/route.ts`, set `fulfilment_type` on insert — `pickup` if `method === 'odbior'`, else `prodigi` if `hasPrints`, else `inpost`. The value is already derivable there.
3. **Switch consumers (gradual, low-risk):** where a consumer currently infers kind by joining `order_items.variant`, prefer reading `orders.fulfilment_type`. Safe candidates: admin data/queue (`02`), returns (`03`), email kind selection (`04`). **Only switch a consumer you can cover with a test.** Leave the webhook fulfilment router (`createShipment`) on `order_items.variant` — it already reads per-item and is correct. Do not chase 100% migration; the column existing + checkout writing it + a couple of consumers switched is the win.

### Finding 9 — drop `pod_variant_id`

Migration: `alter table order_items drop column pod_variant_id`. Re-grep `src/` and `scripts/` first to reconfirm zero references. Leave `pod_variants` and `sync-prodigi-skus` alone.

### Finding 12 — private-sale × prints guard

In the checkout private-sale branch, add an early `return NextResponse.json({ error: 'private_sale_prints_unsupported' }, { status: 400 })` when `privateSaleToken && hasPrints`, before any reservation. Document in `AGENTS.md`/`docs` that private-sale links never include prints.

## Acceptance criteria

- [ ] Migration applies cleanly; every existing order has a correct `fulfilment_type`; column is `NOT NULL` with the CHECK; an invalid value is rejected by the DB.
- [ ] New checkout inserts write the right `fulfilment_type` for ceramic (`inpost`), print (`prodigi`), and pickup (`pickup`) orders.
- [ ] `order_items.pod_variant_id` is gone; `npm run build` + full test suite still green (nothing referenced it).
- [ ] `POST /api/checkout` with a private-sale token **and** prints in the cart → `400`, no reservation attempted.
- [ ] Any consumer switched to `fulfilment_type` behaves identically to its `variant`-based version (proven by its test).

## Tests

- Migration/constraint: insert an order per type; assert a bad `fulfilment_type` is rejected (DB-level test or a scripted check).
- `src/app/api/checkout/route.test.ts` (extend): asserts inserted `fulfilment_type` per order kind; private-sale + prints → `400`.
- Re-run any consumer test you switched (`02`/`03`/`04`) to prove parity.

Run: `npx vitest run src/app/api/checkout/route.test.ts`, then `npm run lint && npm run build`. Apply the migration in your local Supabase and confirm the backfill.

## Boundaries

- Do **not** rip out `order_items.variant`; it stays the per-item truth and the webhook router keeps using it.
- Do **not** make `pod_variants` authoritative or start writing `pod_variant_id` — the decision is to delete, not to promote.
- Keep the consumer switch conservative: only what you can test, this session.
