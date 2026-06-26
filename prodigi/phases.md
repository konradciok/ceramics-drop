# Prodigi Integration — Phases

> Last updated: 2026-06-26
> Read `masterprompt.md` first for full context.

---

## Phase 0 — FIRST SLIDE: Variant Model Reconciliation & SKU Verification

**This is the gate. No code until this is done.**

The existing storefront plan (`docs/superpowers/plans/2026-06-13-fine-art-prints.md`, branch `claude/prints-feature`) designed a variant model with `frame: 'none' | 'oak' | 'black'`. Prodigi Classic Frame Prints use **two distinct SKU families** — with mount (`GLOBAL-CFPM-*`) and without mount (`GLOBAL-CFP-*`) — that have different print areas. These cannot share a single `frame` axis.

### Tasks

**P0-1: Read Prodigi product docs and verify SKUs**
- Fetch `GET /products/{sku}` via Prodigi sandbox for the candidate Classic Frame Print SKUs.
- Confirm: available sizes (in/cm), frame colour attribute values, printAreaSizes for mounted vs unmounted, shipsTo list includes PL + DE + GB.
- Document all verified SKUs in `prodigi/sku-catalog.md` (create this file).

**P0-2: Reconcile variant model**

Replace the storefront plan's `frame: 'none' | 'oak' | 'black'` with:

```typescript
// src/lib/types.ts additions (update from prints-feature plan)
export type PrintFrameColour = 'black' | 'white' | 'natural'  // confirm values vs Prodigi attribute
export type PrintMount = false | true

// Cart token format (replaces print:id:size:paper:frame)
// New: print:{designId}:{size}:{frame_colour}:{mount}
// Example: print:fap01:30x40cm:black:true
```

- Update `PrintVariantSelection` in `src/lib/types.ts`.
- Update cart token encode/decode in `src/lib/print-cart.ts`.
- Update `pod_variants` table design with the correct axes.
- Update `order_items.variant` JSON shape.
- Update `print-pricing.ts` axes.
- Update `PrintConfigurator` UI component plan.

**P0-3: Define the 18-variant matrix**

```
sizes:         3 (to confirm with Prodigi product page)
frame_colours: 3 (black / white / natural)
mount:         false / true
= 18 variants per artwork

For each variant: Prodigi SKU + printAreaWidth + printAreaHeight (pixels at 300 DPI)
```

Write this matrix into `prodigi/sku-catalog.md` with real values from Prodigi API.

**P0-4: Answer the 5 open questions in `masterprompt.md`**

Get decisions on: asset hosting, queue vs direct, InPost for framed prints, storefront token format change.

**Deliverables:**
- `prodigi/sku-catalog.md` — verified SKU matrix with print areas
- Updated `src/lib/types.ts` variant types
- Updated `src/lib/print-cart.ts` token format
- Decisions documented in `prodigi/decisions.md`

**Why this is the first slide:** Every downstream task (DB schema, Prodigi mapper, asset sizing, checkout validation, pricing, UI) depends on the correct variant model. Getting it wrong means rework across every phase.

---

## Phase 1 — Foundations: DB migrations + Prodigi client

**Depends on:** Phase 0 complete (variant model confirmed, SKUs verified)

### P1-1: DB migrations
- Apply `20260613120000_order_items_variant.sql` from `claude/prints-feature` branch.
- Add new migration: `pod_variants` table (seeded with verified SKUs from P0-3).
- Add new migration: `fulfilment_jobs`, `prodigi_orders`, `webhook_events` tables.
- Add new migration: `order_items.pod_variant_id` FK.
- Run `supabase db push` against sandbox DB. Verify schema.

### P1-2: Prodigi client (`src/server/prodigi/client.ts`)
- `fetch` wrapper: sets `X-API-Key`, selects sandbox/live base URL from `PRODIGI_ENV` env var.
- Typed errors (network, non-2xx, outcome≠Ok, idempotent-duplicate).
- Retryability classification.
- Unit tests for error mapping.

### P1-3: SKU sync script (`scripts/sync-prodigi-skus.ts`)
- Call `GET /products/{sku}` for each SKU in the matrix.
- Parse `printAreaSizes`, `shipsTo`, `attributes`.
- Upsert into `pod_variants` table.
- Run manually; also runnable as `npm run sync-prodigi-skus`.

### P1-4: Prodigi types (`src/server/prodigi/types.ts`)
- Request/response types for `POST /orders`, `GET /orders/{id}`, `POST /quotes`, `GET /products/{sku}`.
- `FulfilmentJobMessage` type for queue payload.

**Deliverables:** Prodigi client, types, pod_variants seeded, DB migrations applied.

---

## Phase 2 — Checkout extension (storefront layer)

**Depends on:** Phase 0 (variant model) + Phase 1 (DB + variant table)
**Merges with:** `claude/prints-feature` storefront plan (phases 0–2 in that document)

This phase implements the storefront side. It runs largely in parallel with Phase 3 (fulfilment), since both depend on Phase 1 but not each other.

### P2-1: Types + registry + pricing
- `src/lib/types.ts` — `CategorySlug += 'fine-art-prints'`, `PrintFrameColour`, `PrintMount`, `PrintDesign`, `PrintVariantSelection` (updated from storefront plan to use new axes).
- `src/lib/prints.ts` — `PRINT_DESIGNS` (2–3 sample designs for testing).
- `src/lib/print-pricing.ts` — `priceOfVariant()` with size/colour/mount axes.
- `src/lib/pricing.ts` — add `'fine-art-prints'` entry (price "from").
- Unit tests: `prints.test.ts`, `print-pricing.test.ts`.

### P2-2: Cart token + checkout validation
- `src/lib/print-cart.ts` — `isPrintToken`, `encodePrintToken`, `decodePrintToken`, `variantLabel` (updated token format with mount field).
- `src/lib/checkout.ts` — extend `validateCart` to handle print tokens: decode → validate design + variant available → price → produce `CheckoutItem` with `variant` + `pod_variant_id`.
- `src/app/api/checkout/route.ts` — split `ceramicIds` from prints; reserve only ceramics; insert `order_items` with `variant` + `pod_variant_id`.
- Unit tests: `print-cart.test.ts`, `checkout.test.ts`.

### P2-3: Webhook fix (CRITICAL — eliminates auto-refund)
- `src/lib/webhook.ts` / `src/app/api/stripe/webhook/route.ts` — `markPaid` count guard: filter `.is('variant', null)` (ceramics only).
- Integration test: `print-only order` → no auto-refund; mixed order → ceramics counted correctly.

### P2-4: Frontend — collection + PDP + configurator
- `src/lib/products.ts` — `CATEGORIES['fine-art-prints']`, `CATEGORY_ORDER`.
- `messages/{pl,en,es,de,gb}.json` — nav, collection, notes, print.size/frame_colour/mount labels.
- `src/app/[locale]/(collections)/fine-art-prints/page.tsx` — collection listing.
- `src/components/shop/PrintConfigurator.tsx` — size/frame_colour/mount selectors, dynamic price, unavailable-combination guard, add-to-cart.
- `src/components/shop/PrintProductScreen.tsx` — PDP layout.
- `src/app/[locale]/(pdp)/[slug]/[id]/page.tsx` — branch print vs ceramic.
- `src/lib/seo/product-schema.ts` — `AggregateOffer` for print.
- E2E: `print-configurator.spec.ts`.

### P2-5: Cart view + reconcile
- `src/components/shop/CartView.tsx` — render print token as label (design + size/colour/mount) + price.
- Reconcile (`/api/inventory`): skip print tokens (open edition always available).

**Deliverables:** Full storefront for fine-art prints. Customer can configure + buy. Webhook does not auto-refund print orders.

---

## Phase 3 — Prodigi fulfilment pipeline

**Depends on:** Phase 1 (DB + client) + Phase 2 (checkout creates order_items with pod_variant_id)

### P3-1: Order mapper (`src/server/prodigi/mapper.ts`)
- `buildProdigiPayload(order, items, podVariants)` → Prodigi order JSON.
- Maps: `merchantReference`, `shippingMethod`, `recipient` (from order shipping_address), `items` (SKU, sizing, attributes, assets, recipientCost), `metadata`, `idempotencyKey`, `callbackUrl`.
- `sizing`: use `fillPrintArea` only if aspect ratios match; otherwise require exact pre-sized asset.
- Unit tests: mapper.test.ts — payload shape, idempotency key format, recipientCost in PLN/EUR.

### P3-2: Asset URL generation (`src/server/prodigi/assets.ts`)
- Given `order_id` + `pod_variant_id` → return a URL Prodigi can fetch.
- MVP option: R2 presigned URL with 30-day expiry (requires R2 bucket + binding).
- Fallback: publicly accessible URL if master files are in `public/uploads/` (print-ready versions).
- Log safe fields only; never log full signed URL.

### P3-3: Fulfilment job processor (`src/server/fulfilment/process-job.ts`)
- Implements the 10-step fulfilment flow from `masterprompt.md`.
- Idempotency: check `fulfilment_jobs.status` before calling Prodigi.
- On Prodigi 201 success: insert `prodigi_orders`, update `fulfilment_jobs.status = 'submitted'`.
- On idempotent duplicate (Prodigi returns existing order): extract `prodigi_order_id`, mark submitted.
- On retryable error: increment `attempts`, update `last_error`, re-queue/return error.
- On non-retryable: set `status = 'failed_action_required'`.
- Unit tests: process-job.test.ts — all branches.

### P3-4: Enqueue fulfilment (`src/server/fulfilment/enqueue.ts`)
- Called from `handleStripeEvent` after `markPaid`.
- Creates `fulfilment_jobs` row (idempotent — unique constraint on `order_id`).
- If Cloudflare Queue binding exists: push `FulfilmentJobMessage` to queue.
- If no queue: call `process-job.ts` directly (simpler, less resilient).
- Document the trade-off in `prodigi/decisions.md`.

### P3-5: Queue consumer (if using CF Queues)
- `worker.ts` queue handler export (alongside existing scheduled handler).
- Deserialise `FulfilmentJobMessage`, call `process-job.ts`.
- On success: acknowledge.
- On retryable error: throw (Cloudflare retries at-least-once).
- On non-retryable: ack + mark DB as failed_action_required.

### P3-6: Prodigi callback endpoint (`src/app/api/webhooks/prodigi/route.ts`)
- Validate `PRODIGI_CALLBACK_TOKEN` in URL.
- Store raw event in `webhook_events` (dedupe by `provider_event_id`).
- Fetch order state from `GET /orders/{prodigi_order_id}` (authenticated).
- Update `prodigi_orders.prodigi_status_stage` + `prodigi_raw_json`.
- Map stage → local status via `status-map.ts`.
- Never overwrite terminal status.
- Return 200 always (so Prodigi doesn't retry forever); log errors internally.
- Integration tests: callback-dedup, state fetch, terminal-status guard.

**Deliverables:** End-to-end Prodigi fulfilment. Paid print order → Prodigi order created → status tracked via callbacks.

---

## Phase 4 — Admin visibility + operational tooling

**Depends on:** Phase 3

### P4-1: Admin order detail — Prodigi fields
- `src/app/admin/orders/[id]/page.tsx` — add section showing: Prodigi order id, stage, last callback timestamp, idempotency key, link to Prodigi sandbox dashboard.
- Show `fulfilment_jobs.status`, `attempts`, `last_error`.

### P4-2: Retry fulfilment action
- `src/app/api/admin/retry-fulfilment/route.ts` (POST, Cloudflare Access gated).
- Resets `fulfilment_jobs.status` to 'queued' and re-enqueues.
- Only valid for `failed_retryable` or `failed_action_required`.

### P4-3: Admin callback log
- Show recent `webhook_events` rows for a given order in the admin detail view.
- Useful for diagnosing missed callbacks.

### P4-4: Environment variable documentation
- Update `.env.example` with Prodigi placeholders.
- Update `docs/cloudflare-deployment.md` with new secrets.
- Create `prodigi/runbook.md` — sandbox test procedure, live cutover steps, cancel/retry procedures.

**Deliverables:** Admin can monitor and retry Prodigi fulfilment without touching the DB.

---

## Phase 5 — Tests + build verification + sandbox smoke test

**Depends on:** All prior phases

### P5-1: Full test suite
- `npm run test` — all Vitest unit + integration tests pass.
- Specific new suites: mapper, client errors, status-map, process-job, enqueue, dedup (webhook + queue).
- Specific regression: existing ceramics checkout, webhook mark-paid, email, InPost tests unchanged.

### P5-2: E2E
- `purchase-print.spec.ts` — full checkout of a print, verify `prodigi_orders` row created (sandbox).
- `purchase-mixed.spec.ts` — ceramic + print, verify ceramic reserved + print fulfilment enqueued.
- Existing ceramics E2E passes without modification.

### P5-3: Build + preview
- `npm run build` (webpack, no Turbopack).
- `npm run preview:cf` — smoke test on Workers runtime.
- No ChunkLoadError, no missing bindings.

### P5-4: Sandbox order smoke test
- Set `PRODIGI_ENV=sandbox`, real Prodigi sandbox API key.
- Run `npm run sync-prodigi-skus` — all SKUs verify OK.
- Place a test order for a print → verify Prodigi sandbox order created, callback received, status updated.

**Deliverables:** Green CI, verified sandbox flow, ready for live cutover checklist.

---

## Phase 6 (deferred) — Limited edition stock + full admin panel

Out of scope for MVP. Depends on Phases 0–5 complete and live.

- `print_stock` table + `claim_print_units()` RPC (designed in storefront plan, migration B).
- Integration in checkout (claim units) + webhook (release on refund/fail).
- Badge "N of M remaining" in `PrintConfigurator`.
- Full CRUD admin panel for print designs + variant matrix (behind Cloudflare Access).
- Automated margin monitoring via `POST /quotes` on a scheduled cron.

---

## Dependency graph

```
P0 (variant model) ──┬──► P1 (DB + client) ──┬──► P2 (storefront)
                     │                         │
                     │                         └──► P3 (fulfilment) ──► P4 (admin) ──► P5 (tests)
                     │
                     └── Decisions: queue, asset hosting, InPost framed
```

P2 and P3 can run in parallel once P1 is complete, as long as the DB schema is agreed.

---

## Key risks per phase

| Phase | Risk | Mitigation |
|---|---|---|
| P0 | Wrong SKUs / print areas → misprinted fulfilment | Verify every SKU against live Prodigi API before writing any mapper |
| P0 | Token format change breaks `claude/prints-feature` plan | Agree token format in P0, update plan before implementing P2 |
| P2 | Auto-refund from `markPaid` count guard | Integration test is a gate for merging P2 |
| P3 | Prodigi live orders if `PRODIGI_ENV` accidentally set to live | Env gate + live orders require explicit checklist sign-off |
| P3 | Asset URL expires before Prodigi downloads | Long expiry (30d) or Worker proxy; retry path regenerates URL |
| P3 | At-least-once queue → duplicate Prodigi orders | Idempotency key + unique constraint on `fulfilment_jobs.order_id` |
| P3 | Callback trusted blindly | Always re-fetch order from Prodigi after callback |
| P4 | No retry path → stuck failed orders | P4-2 retry action is part of MVP admin scope |
