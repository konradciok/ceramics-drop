# Prodigi Fulfilment Integration — Master Prompt

> Last updated: 2026-06-26
> Repo: `konradciok/ceramics-drop` — Next.js 16 / Supabase / Stripe / Cloudflare Workers via OpenNext
> Reference plan: `docs/superpowers/plans/2026-06-13-fine-art-prints.md` (storefront layer, branch `claude/prints-feature`)
> Reference instructions: Claude Code Prodigi Integration Instructions (uploaded, 2026-06-26)

---

## Context for executing agents

You are implementing Prodigi Classic Frame Print fulfilment for the anna-ciok.studio storefront.

**This is not a greenfield Prodigi integration.** A parallel plan already exists for the storefront layer (how customers pick and purchase configurable fine-art prints). Your job is to:

1. Reconcile that storefront variant model with Prodigi's actual SKU structure.
2. Build the Prodigi fulfilment layer on top of the existing Stripe/Supabase/Cloudflare commerce stack.
3. Never break the existing ceramics flow.

Read `AGENTS.md` and `CLAUDE.md` before touching any file. Build must stay `next build --webpack`.

---

## Repository state (verified 2026-06-26)

### What already exists (main branch)

| Layer | What's there |
|---|---|
| Framework | Next.js 16 App Router, React 19, OpenNext on Cloudflare Workers |
| Database | Supabase (PostgreSQL, RLS enabled, service-role only) |
| Payments | Stripe PaymentIntent — dynamic amount, no Stripe Products/Prices |
| Shipping | InPost ShipX (Paczkomat + Kurier + Odbiór) |
| Webhook | `src/lib/webhook.ts` → `handleStripeEvent()` — idempotent, keyed by `payment_intent_id` |
| Cart | Zustand `ids: string[]`, localStorage `acc_cart_v1`, no quantities |
| Validation | No Zod/Valibot — plain TypeScript + manual checks |
| Async jobs | Cron via `worker.ts` (every 15 min, order expiry only) — **no Cloudflare Queues** |
| Storage | Static `public/uploads/` WebP images (display-optimised) — **no R2, no high-res master files** |
| Admin | Deployed on production Workers bundle at `anna-ciok.studio`; gated by Cloudflare Access JWT in `worker.ts`; local bypass via `STUDIO_ADMIN_LOCAL_BYPASS` env var |

### What exists on `claude/prints-feature` branch (storefront plan, not yet merged)

- Full plan at `docs/superpowers/plans/2026-06-13-fine-art-prints.md`
- DB migration `supabase/migrations/20260613120000_order_items_variant.sql` — adds `order_items.variant jsonb`, surrogate PK `id uuid`, partial unique index for ceramics
- **No application code implemented yet** — the branch is planning stage only

The storefront plan defines:
- Cart token format: `print:<designId>:<size>:<paper>:<frame>` (e.g. `print:fap01:a3:matte:oak`)
- TypeScript types: `PrintDesign`, `PrintSize`, `PrintPaper`, `PrintFrame`, `PrintVariantSelection`
- Variant axes: `size` (a4/a3/a2) × `paper` (matte/satin) × `frame` (none/oak/black)
- Pricing: `priceOfVariant()` in `src/lib/print-pricing.ts`
- Critical webhook fix: `markPaid` count guard must filter `is('variant', null)` — ceramics only

### Critical collision: variant model vs Prodigi SKU structure

The existing storefront plan has `frame` as a single axis with values `none | oak | black`. **This is wrong for Prodigi.** Prodigi treats mounted (passe-partout) and unmounted frames as **different SKU families** with different print areas:

- No mount: `GLOBAL-CFP-{SIZE}` — print area ≈ full glazing size
- With mount/passe-partout: `GLOBAL-CFPM-{SIZE}` — print area is the mount window, smaller than frame

An 18×24 in framed print with mount has a 14×20 in print/window opening. The wrong image size → rejected or misaligned fulfilment.

**Reconciled variant model** (replaces the existing storefront plan's `frame` axis; verified in `sku-catalog.md`):

```text
size         : '30x40' | '50x70' | '70x100'          (store labels; Prodigi suffixes 12X16, 20X28, 28X40)
framed       : false | true                           false → GLOBAL-FAP (loose print); true → CFP/CFPM
mount        : false | true                           passe-partout; only when framed=true (CFP vs CFPM)
frame_colour : 'black' | 'white' | 'natural'         only when framed=true; maps to attributes.color
paper        : 'EMA'                                   fixed at MVP (Prodigi paperType; not a UI axis)
```

Combinatorics: 3 unframed + 3 sizes × 3 colours × 2 mount states = **21** fulfilment variants per artwork.

Cart token: `print:{designId}:{size}:{framed}:{mount}:{frame_colour}`

This changes:
- The cart token format (add `mount` field)
- The `order_items.variant` JSON shape
- The `pod_variants` table (source of truth for Prodigi SKU + print area dimensions)
- The pricing model (mounted variants may cost more)

---

## Architecture constraints (non-negotiable)

1. Never call Prodigi from the browser.
2. Never create Prodigi orders from the Stripe success-page redirect.
3. Create fulfilment only after a verified Stripe server-side webhook event (`payment_intent.succeeded`).
4. Queue processing is at-least-once — idempotency required at DB layer and in Prodigi payloads.
5. Prodigi API keys stay server-side only (Cloudflare Worker secrets).
6. Prodigi sandbox for all dev/test; live only when explicitly configured and gated.
7. Do not break the existing ceramics checkout, webhook, fulfillment, InPost, or email flows.
8. Build stays `next build --webpack`. No Turbopack.
9. Match existing conventions: plain TypeScript validation, Supabase service-role, Resend emails, no Zod.
10. **Guard `createShipment`:** InPost `createShipment` currently runs for every paid order inside `handleStripeEvent`. It must be guarded to run only when the order contains ceramic items (`order_items` rows with `variant is null`). Print-only orders must not hit InPost ShipX.
11. **Guard `ensureInvoiced` / `invoice.ts`:** The invoice helper calls `getProductById(it.product_id)` which will return `undefined` or produce mislabelled invoices for print tokens. It must be extended to handle print line items before any print orders can be paid.

---

## Environment variables to add

**Runtime secrets** (`wrangler secret put` in prod, `.dev.vars` locally):

```bash
PRODIGI_API_KEY_SANDBOX=...
PRODIGI_API_KEY_LIVE=...
PRODIGI_ENV=sandbox                    # switch to "live" only after full checklist
PRODIGI_CALLBACK_TOKEN=...             # unguessable token for callback URL
PRINT_ASSET_TOKEN_SECRET=...           # signs print-asset access tokens
PRODIGI_DEFAULT_SHIPPING_METHOD=Budget
```

> **Note — no `PRODIGI_DEFAULT_CURRENCY`:** The store is tri-currency (PLN/EUR/GBP). `recipientCost` on every Prodigi order item must be derived from `orders.currency` (mapped from the checkout locale: `pl → PLN`, `gb → GBP`, `en/es/de → EUR`). A single default currency would be wrong for non-PLN orders. The mapper must read `order.currency` and format the amount accordingly.

Add placeholders to `.env.example` — no real values.

**`cloudflare-env.d.ts`** — add bindings for Queues if you add them, and for R2 if used.

---

## Data model additions

All new migrations go in `supabase/migrations/` with timestamp prefix.

### Already committed (branch `claude/prints-feature`)

`20260613120000_order_items_variant.sql` — adds `variant jsonb` + surrogate PK to `order_items`.

### To add (Prodigi layer)

```sql
-- pod_variants: source of truth for Prodigi SKU + print-area dimensions
create table pod_variants (
  id                  uuid primary key default gen_random_uuid(),
  provider            text not null default 'prodigi',
  prodigi_sku         text not null unique,
  display_size_label  text not null,          -- e.g. '30x40 cm'
  frame_colour        text not null,          -- 'black' | 'white' | 'natural'
  mount_enabled       boolean not null,
  mount_colour        text not null default 'snow_white',
  paper               text not null default 'enhanced-matte',
  glazing             text not null default 'perspex',
  print_area_name     text not null default 'default',
  print_area_width_px  integer,
  print_area_height_px integer,
  ships_to_json       jsonb,
  active              boolean not null default true,
  provider_raw_json   jsonb,
  last_synced_at      timestamptz
);
alter table pod_variants enable row level security;

-- fulfilment_jobs: tracks one job per order
create table fulfilment_jobs (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references orders(id),
  provider        text not null default 'prodigi',
  status          text not null default 'queued',
  attempts        integer not null default 0,
  idempotency_key text not null unique,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index fulfilment_jobs_order_unique on fulfilment_jobs(order_id)
  where status not in ('cancelled', 'failed_action_required');
alter table fulfilment_jobs enable row level security;

-- prodigi_orders: links internal orders to Prodigi
create table prodigi_orders (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references orders(id),
  prodigi_order_id    text unique,
  prodigi_status_stage text,
  prodigi_raw_json    jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
alter table prodigi_orders enable row level security;

-- webhook_events: raw callback storage for dedup
create table webhook_events (
  id                uuid primary key default gen_random_uuid(),
  provider          text not null,
  provider_event_id text,
  event_type        text,
  raw_json          jsonb,
  processed_at      timestamptz,
  created_at        timestamptz not null default now()
);
create unique index webhook_events_provider_event_id
  on webhook_events(provider, provider_event_id)
  where provider_event_id is not null;
alter table webhook_events enable row level security;
```

`order_items` also needs a reference to `pod_variants`:

```sql
alter table order_items add column pod_variant_id uuid references pod_variants(id);
```

---

## Module structure (adapt to repo conventions)

```text
src/server/prodigi/
  client.ts         # fetch wrapper, sandbox/live base URL, X-API-Key header, typed errors
  types.ts          # Prodigi API request/response types (plain TS, no Zod)
  products.ts       # GET /products/{sku} — sync SKU details + printAreaSizes
  orders.ts         # POST /orders, GET /orders/{id}, cancel/update helpers
  quotes.ts         # POST /quotes
  callbacks.ts      # callback parse (validate CloudEvents shape before reading id/type/data), dedupe, re-fetch order state
  mapper.ts         # local order + items → Prodigi order payload
  errors.ts         # typed errors + retryability classification

src/server/fulfilment/
  enqueue.ts        # enqueue fulfilment job (direct or via CF Queue)
  process-job.ts    # queue consumer / direct call: load → verify → map → call → persist
  status-map.ts     # Prodigi status.stage → local status

src/app/api/webhooks/prodigi/route.ts   # callback endpoint
src/app/api/stripe/webhook/route.ts     # EXISTING — extend to enqueue after payment_intent.succeeded

scripts/
  sync-prodigi-skus.ts    # verify selected SKUs with GET /products/{sku}, store in pod_variants
```

**Important — `DOQueueHandler` is NOT a fulfilment queue.** `worker.ts` re-exports `DOQueueHandler` from OpenNext — this is cache/tag invalidation infrastructure for the Next.js runtime, not a Cloudflare Queue for Prodigi fulfilment. Do not conflate the two.

**Adding Cloudflare Queues for fulfilment (if chosen)** requires all of the following:

1. `wrangler.jsonc` — add producer + consumer bindings:

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

1. `cloudflare-env.d.ts` — add binding type:

```typescript
FULFILMENT_QUEUE: Queue;
```

Then run `npm run cf-typegen` to regenerate types.

1. `worker.ts` — add `queue` handler alongside the existing `fetch` and `scheduled` exports:

```typescript
export default {
  fetch: handler.fetch,
  scheduled: handler.scheduled,
  async queue(batch: MessageBatch<FulfilmentJobMessage>, env: CloudflareEnv, ctx: ExecutionContext) {
    for (const msg of batch.messages) {
      await processJob(msg.body, env, ctx)
        .then(() => msg.ack())
        .catch((err) => {
          // Non-retryable errors (validation failure, unknown SKU, permanent Prodigi 4xx)
          // must be acked so they don't consume retries and go straight to DLQ.
          if (err?.retryable === false) msg.ack()
          else msg.retry()
        })
    }
  }
}
```

Without all three, Cloudflare will not route queue messages to your consumer.

---

## Prodigi API facts

**Environments:**
- Sandbox: `https://api.sandbox.prodigi.com/v4.0`
- Live: `https://api.prodigi.com/v4.0`
- Auth header: `X-API-Key: <key>`

**Endpoints to implement:**
- `POST /orders` — create order
- `GET /orders/{id}` — fetch order state
- `GET /orders/{id}/actions` — available actions (for cancel check)
- `POST /orders/{id}/actions/cancel` — cancel (admin only)
- `GET /products/{sku}` — get SKU details + printAreaSizes + shipsTo
- `POST /quotes` — price check (optional, for margin validation)

**Idempotency key format:**

```text
prodigi:{env}:order:{internal_order_id}:v1
```

**Callback URL format:**

```text
https://anna-ciok.studio/api/webhooks/prodigi/{PRODIGI_CALLBACK_TOKEN}
```

**Callback payload format (Prodigi uses CloudEvents spec):**

Prodigi callbacks are CloudEvents. Extract fields as follows:

```typescript
const cloudEvent = await req.json()
const providerEventId = cloudEvent.id         // use as webhook_events.provider_event_id
const eventType = cloudEvent.type              // e.g. "com.prodigi.order#/status/stage/InProduction"
// prodigiOrderId is always in cloudEvent.data.prodigiOrderId for all Prodigi order events.
// Do NOT fall back to parsing the URL — if data.prodigiOrderId is missing, reject with 400.
const prodigiOrderId = cloudEvent.data?.prodigiOrderId
```

**Callback handling:**
1. Receive callback, validate `PRODIGI_CALLBACK_TOKEN` in URL; reject malformed CloudEvents early (check `id`, `type`, `data.prodigiOrderId` exist — return **400** for permanent shape failures, not 200)
2. Atomically upsert into `webhook_events` on unique `(provider, provider_event_id)` with `status = 'processing'` and `processing_started_at = now()` — this is the concurrency claim/lock. If the upsert conflicts (row already exists), check its `status`: return 200 immediately if `status = 'done'`; if `status = 'processing'`, check the lease: no-op and return 200 if `processing_started_at > now() - 5 minutes` (in-flight); reacquire the lock (UPDATE the row) if stale (`processing_started_at <= now() - 5 minutes`) — this handles handler crashes without permanently freezing the event
3. Fetch Prodigi order via `GET /orders/{id}` (authenticated — never trust callback payload alone)
4. Update local `prodigi_orders` + `fulfilment_jobs` status
5. Update `webhook_events` row: set `status = 'done'`, `processed_at = now()` after durable success
6. Return 200 only after step 5 completes; for transient errors (network, DB timeout) return **500** so Prodigi retries; for non-retryable errors (unknown order ID, contract violation) return **400** — do not swallow all errors with a blanket 200

---

## Fulfilment flow (complete)

```text
payment_intent.succeeded webhook (handleStripeEvent in src/lib/webhook.ts)
  → markPaid (filter variant IS NULL for count guard — ceramics only)
  → trackPurchase (existing — consent-gated Meta CAPI + GA4 MP, unchanged)
  → ensureInvoiced (existing — MUST be extended to handle print line items; errors swallowed)
  → createShipment  IF order has ceramic items (variant IS NULL)
                    (re-throws retryable errors so Stripe retries; must NOT be called for print-only orders)
  → enqueueProdigi  IF order has print items (variant IS NOT NULL)
    → create fulfilment_jobs row (idempotent — unique constraint on order_id)
    → push to Cloudflare Queue OR process inline (see P3-4 in phases.md)

queue consumer / process-job.ts:
  1. load order from DB
  2. verify order.status = 'paid'
  3. verify no active fulfilment_jobs already submitted to Prodigi
  4. load order_items where variant is not null (print items only)
  5. verify each item has valid active pod_variant_id
  6. resolve/generate print asset URL
  7. build Prodigi payload via mapper.ts
  8. POST /orders with idempotency key
  9. persist prodigi_orders row + update fulfilment_jobs status
  10. on retryable error → re-queue; on non-retryable → status = failed_action_required
```

**Ceramics flow is unchanged.** Prodigi fulfilment only runs for order items with `variant is not null`.

---

## Asset handling (MVP approach)

Print files must be accessible via a permanent URL. Master artwork files are not yet stored anywhere server-side. Options:

**Option A (decided — Q2):** R2 presigned URLs generated in the queue consumer when submitting to Prodigi.
- Upload master artwork to Cloudflare R2 (manual or script)
- Generate presigned GET URL with long expiry (30 days) per order item
- Regenerate if expired before Prodigi downloads

**Option B (robust):** Worker asset-proxy endpoint
- `/api/print-assets/{token}` — token maps to artwork file + order item
- Worker streams from R2 to Prodigi
- Full control over expiry, revocation, access logging

Either option requires a Cloudflare R2 bucket binding in `wrangler.jsonc` and artwork upload workflow.

**Image sizing:** Use `printAreaSizes` from `GET /products/{sku}` to preflight dimensions. The mounted variant print area is smaller than the frame size. Never use `stretchToPrintArea`. Prefer generating a correctly sized image over relying on API-side crop.

---

## Pricing strategy (Strategy A — local matrix)

The existing `print-pricing.ts` plan is Strategy A: local price table is source of truth. Prodigi `POST /quotes` is optional, for margin validation only.

`recipientCost` on the Prodigi order item should reflect what the customer paid (for customs/international). Map from `order_items.unit_price` (in minor units, in order currency).

---

## Status mapping

Local statuses for Prodigi-fulfilled items:

```text
pending_payment        → order not yet paid
paid_pending_fulfilment → paid, job not yet created
fulfilment_queued      → job in queue
fulfilment_submitting  → calling Prodigi API
fulfilment_submitted   → Prodigi order created
in_production          → Prodigi status.stage = InProduction
shipped                → Prodigi status.stage = Complete + shipment exists
completed              → delivered / all good
cancelled              → Prodigi order cancelled
failed_retryable       → transient error, will retry
failed_action_required → non-retryable, needs human
```

Never overwrite a terminal status (completed/cancelled/failed_action_required) with an older callback.

---

## Error classification

Prodigi client must distinguish:

| Error type | Retryable |
|---|---|
| Network failure / timeout | Yes |
| 5xx from Prodigi | Yes (with backoff) |
| 4xx — order validation | No (log + failed_action_required) |
| Idempotent order already created | No-op (extract order id, mark submitted) |
| Asset URL generation failure | Depends — if regeneratable, retry |
| Unsupported SKU | No |
| Non-2xx with outcome != 'Ok' | Check outcome field |

---

## Tests to add

**Unit (Vitest):**
- `prodigi/client.test.ts` — error classification, sandbox/live URL selection
- `prodigi/mapper.test.ts` — local order → Prodigi payload, idempotency key, recipientCost
- `prodigi/status-map.test.ts` — Prodigi stage → local status, terminal state guard
- `fulfilment/process-job.test.ts` — paid-only guard, duplicate-fulfilment guard, asset URL resolution

**Integration (mocked Prodigi + Supabase):**
- `stripe webhook payment_intent.succeeded` → fulfilment_jobs row created
- duplicate webhook → no duplicate fulfilment_jobs
- queue consumer → one prodigi_orders row
- duplicate queue delivery → no duplicate Prodigi API call (idempotency key dedup)
- Prodigi callback → authenticated re-fetch → local status updated

**Regression:**
- All existing ceramic checkout + webhook tests pass unchanged
- `markPaid` count guard: `is('variant', null)` is already in the storefront plan — verify it's in the implementation

---

## What this plan does NOT cover (out of scope for MVP)

- Limited-edition print stock tracking (faza 2 in the storefront plan)
- Admin UI for retrying/cancelling Prodigi orders (planned for later)
- Paper selector (fixed Enhanced Matte at MVP)
- Glazing selector (fixed Perspex/acrylic at MVP)
- Mount colour selector (fixed snow white at MVP)
- Stripe Price objects or Stripe Tax
- Automated margin monitoring via Prodigi quotes
- Multiple fulfilment providers

---

## Live cutover checklist

Do not set `PRODIGI_ENV=live` until all items below are verified:

- [ ] Prodigi live API key set as Worker secret
- [ ] All selected SKUs verified via live `GET /products/{sku}` — printAreaSizes + shipsTo PL/EU/GB confirmed
- [ ] Product pricing verified against live Prodigi quotes
- [ ] Asset URLs survive 30-day window (or proxy is in place)
- [ ] Sandbox order flow tested end-to-end
- [ ] Stripe webhook signature verified in deployed environment
- [ ] Idempotency: duplicate webhook test passed
- [ ] Idempotency: duplicate queue delivery test passed
- [ ] `markPaid` count guard test passes for print-only and mixed order
- [ ] Admin can see Prodigi order id + status in local-admin panel
- [ ] Cancellation path documented (Prodigi actions API)
- [ ] Asset regeneration path documented

---

## Phase 0 decisions (resolved — see `decisions.md`)

All five P0-4 questions answered 2026-06-26:

1. **Variant axes** — 3 sizes, framed/mount/colour model, 21 variants (`sku-catalog.md`)
2. **Asset hosting** — Cloudflare R2, presigned GET at queue consumer time
3. **Queue** — `FULFILMENT_QUEUE` (Cloudflare Queue), not inline webhook
4. **Ceramics vs prints** — separate customers/carts; ceramics = drops + InPost; prints = Prodigi ship; no mixed cart
5. **Token format** — `print:{designId}:{size}:{framed}:{mount}:{frame_colour}`
