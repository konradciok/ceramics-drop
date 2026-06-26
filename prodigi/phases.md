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
// paper is fixed at 'enhanced-matte' for MVP — not a variable axis yet
// (add as selectable axis in Phase 6 if multi-paper support is needed)

// Cart token format (replaces print:id:size:paper:frame)
// New: print:{designId}:{size}:{frame_colour}:{mount}
// Example: print:fap01:30x40cm:black:true
// paper omitted from token because it is fixed at MVP
```

- Update `PrintVariantSelection` in `src/lib/types.ts`.
- Update cart token encode/decode in `src/lib/print-cart.ts`.
- Update `pod_variants` table design with the correct axes.
- Update `order_items.variant` JSON shape.
- Update `print-pricing.ts` axes.
- Update `PrintConfigurator` UI component plan.

**P0-3: Define the 18-variant matrix**

```text
sizes:         3 (to confirm with Prodigi product page)
frame_colours: 3 (black / white / natural)
mount:         false / true
paper:         fixed: enhanced-matte (not a variable axis at MVP)
= 18 variants per artwork (3 × 3 × 2)

For each variant: Prodigi SKU + printAreaWidth + printAreaHeight (pixels at 300 DPI)
```

Write this matrix into `prodigi/sku-catalog.md` with real values from Prodigi API.

**P0-4: Answer the 5 open questions in `masterprompt.md`**

All 5 require explicit decisions documented in `prodigi/decisions.md`:

1. **Variant axes** — confirm sizes, frame colours, mount colours from Prodigi API (P0-1 resolves this; document confirmed values)
2. **Asset hosting** — R2 presigned URL vs Worker proxy vs public path
3. **Queue vs direct** — Cloudflare Queue binding or `ctx.waitUntil` inline fallback
4. **Shipping for framed prints** — Prodigi ships directly from their labs; decide mixed-order delivery UX and whether to inform customers about two-parcel fulfilment
5. **Storefront token format** — confirm no other code has consumed the old `print:id:size:paper:frame` token before changing it

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

### P2-3: Webhook fixes (CRITICAL — three blockers)

**P2-3a: `markPaid` count guard (eliminates auto-refund)**

- `src/lib/webhook.ts` / `src/app/api/stripe/webhook/route.ts` — filter `.is('variant', null)` on both `expectedCount` and `fulfilledCount` queries.
- Integration test: `print-only order` → no auto-refund; mixed order → ceramics counted correctly.

**P2-3b: `createShipment` guard (eliminates InPost call on print orders)**

- `handleStripeEvent` in `src/lib/webhook.ts` — wrap `createShipment` call with a check: only call it when the order contains at least one ceramic item (`order_items` row with `variant IS NULL`).
- Pattern: load item types before deciding which fulfilment path to take.
- Integration test: print-only order → `createShipment` not called; mixed order → called once for ceramics.

**P2-3c: `ensureInvoiced` / `invoice.ts` extension (eliminates crash on print tokens)**

- `src/lib/invoice.ts` (or wherever `ensureInvoiced` lives) — `getProductById(it.product_id)` returns `undefined` for print tokens. Extend to decode print token and produce a meaningful invoice line (design name + variant label) instead of crashing or producing a blank line.
- Integration test: invoice generated for print-only order without error; line items describe the print correctly.

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
- **Shipping model note:** Prodigi fulfils and ships prints directly from their labs — not via InPost. The `recipient` is populated from `orders.shipping_address` (the same customer address), but the `shippingMethod` is a Prodigi shipping tier (`Budget`, `Standard`, `Express`), not an InPost method. For mixed orders (ceramics + prints), the ceramics ship via InPost as normal and prints ship separately from Prodigi — the customer may receive two parcels. This must be documented in the checkout UI and confirmed in Phase 0 (open question 4).
- Unit tests: mapper.test.ts — payload shape, idempotency key format, recipientCost mapped from `orders.currency` (PLN/EUR/GBP).

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

- Called from `handleStripeEvent` after `markPaid` (and after `createShipment` check for ceramics).
- Creates `fulfilment_jobs` row (idempotent — unique constraint on `order_id`).
- **Recommended default:** use Cloudflare Queue binding — push `FulfilmentJobMessage` to queue. This gives at-least-once delivery, automatic retries, and does not risk Stripe webhook timeout (25 s limit).
- **Inline fallback (only if no CF Queue):** call `process-job.ts` inside `ctx.waitUntil(...)` — never inline and never throw from the webhook handler on Prodigi errors, as rethrowing causes Stripe to retry the entire webhook (which would run `markPaid` again and could double-send emails). Pattern:

```typescript
ctx.waitUntil(processJob(jobId, env).catch(err => {
  console.error('Prodigi inline processing failed', err)
  // DB row already has status/error; do not throw
}))
```

- Document the chosen approach in `prodigi/decisions.md`.

### P3-5: Queue consumer (if using CF Queues)

**Required wrangler.jsonc additions:**

```jsonc
"queues": {
  "producers": [{ "binding": "FULFILMENT_QUEUE", "queue": "prodigi-fulfilment" }],
  "consumers": [{
    "queue": "prodigi-fulfilment",
    "max_batch_size": 1,
    "max_retries": 10,
    "dead_letter_queue": "prodigi-fulfilment-dlq"
  }]
}
```

**Required `cloudflare-env.d.ts` addition:**

```typescript
FULFILMENT_QUEUE: Queue;
```

Run `npm run cf-typegen` after updating the binding.

**Required `worker.ts` addition** (alongside existing `fetch` and `scheduled` exports):

- Export `queue` handler that deserialises `FulfilmentJobMessage` and calls `process-job.ts`.
- On success: `msg.ack()`.
- On retryable error: `msg.retry()` — Cloudflare retries at-least-once.
- On non-retryable: `msg.ack()` + mark DB as `failed_action_required` (do not leave in dead letter without DB update).

### P3-6: Prodigi callback endpoint (`src/app/api/webhooks/prodigi/route.ts`)

- Validate `PRODIGI_CALLBACK_TOKEN` in URL.
- Parse payload as CloudEvents format. Extract:
  - `provider_event_id = cloudEvent.id` — unique event identifier for dedup
  - `event_type = cloudEvent.type` — e.g. `com.prodigi.order#/status/stage/InProduction`
  - `prodigi_order_id` from `cloudEvent.data` (field name TBC from Prodigi docs)
- Store raw event in `webhook_events` with `(provider='prodigi', provider_event_id)` — dedupe via unique index.
- Fetch order state from `GET /orders/{prodigi_order_id}` (authenticated — never trust callback payload state alone).
- Update `prodigi_orders.prodigi_status_stage` + `prodigi_raw_json`.
- Map stage → local status via `status-map.ts`.
- Never overwrite terminal status (`completed`, `cancelled`, `failed_action_required`).
- Return 200 always (so Prodigi doesn't retry forever); log errors internally.
- Integration tests: CloudEvents parse, callback-dedup (same `cloudEvent.id` ignored), state fetch, terminal-status guard.

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
- Multi-paper selector (add `paper` as variable axis if demand exists).

---

## Dependency graph

```text
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
