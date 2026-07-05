# Fine Art Prints + Prodigi Fulfilment — Design Spec

> Date: 2026-06-26  
> Branch: `feat/fine-art-prints-prodigi` (fresh from `main`)  
> Supersedes: `claude/prints-feature` (PR #97), `claude/wizardly-lalande-14194d` (PR #82), `codex/fine-art-prints-plan` (PR #80)  
> Reference: `prodigi/masterprompt.md`, `prodigi/phases.md`, `prodigi/sku-catalog.md`, `prodigi/decisions.md`

---

## 1. Scope

One branch, one merge. Delivers two layers together:

1. **Storefront layer** — collection page, PDP, configurator, cart, checkout for fine-art prints with the correct Prodigi variant model
2. **Fulfilment layer** — Prodigi order creation, asset delivery via R2, Cloudflare Queue consumer, callback endpoint, admin visibility

Ceramics are untouched. Every existing ceramic test must pass unchanged.

---

## 2. What gets ported from `claude/prints-feature`

Port the mechanics; replace the variant model and labels end-to-end.

| File | Action |
|---|---|
| `src/lib/fulfillment.ts` | Port as-is — ceramic count guard (`IS NULL`) is correct |
| `src/app/api/stripe/webhook/route.ts` | Port + add `createShipment` guard (see §6) |
| `supabase/migrations/20260613120000_order_items_variant.sql` | Port as-is |
| `src/lib/checkout.ts` (`validateCart` print branch) | Port, update axes |
| `src/app/api/checkout/route.ts` (ceramic-only reservation, `has_prints` meta) | Port, update `CheckoutVariant` shape |
| `src/lib/invoice.ts` (print line item label) | Port, update `variantLabel` call |
| `src/lib/email.ts`, `src/lib/cart-lines.ts`, `src/lib/marketing/conversions.ts` | Port |
| UI: `PrintConfigurator`, `PrintCollectionScreen`, `PrintProductScreen`, collection page | Port, swap axes in UI |
| All test files from `claude/prints-feature` | Port, update for new axes |

Discard (rebuild from scratch): `src/lib/types.ts` print types, `src/lib/print-cart.ts`, `src/lib/prints.ts`, `src/lib/print-pricing.ts`.

---

## 3. Variant model

Authoritative source: `prodigi/sku-catalog.md` (verified against Prodigi sandbox API 2026-06-26).

```typescript
// src/lib/types.ts additions
export type PrintSize = '30x40' | '50x70' | '70x100'
export type PrintFrameColour = 'black' | 'white' | 'natural'

export interface PrintVariantSelection {
  size: PrintSize
  framed: boolean
  mount: boolean          // passe-partout; only meaningful when framed=true
  frameColour: PrintFrameColour | 'none'  // 'none' when framed=false
}
```

**21 combinations per design:** 3 unframed (size only) + 3 sizes × 3 colours × 2 mount states.

**Cart token:** `print:{designId}:{size}:{framed}:{mount}:{frameColour}`  
Examples: `print:fap01:30x40:false:false:none` · `print:fap01:50x70:true:true:natural`

**`order_items.variant` JSON** (denormalised at checkout):
```json
{
  "kind": "print",
  "designId": "fap01",
  "size": "50x70",
  "framed": true,
  "mount": true,
  "frameColour": "natural",
  "prodigiSku": "GLOBAL-CFPM-20X28",
  "printAreaPx": { "w": 4800, "h": 7200 }
}
```

`prodigiSku` and `printAreaPx` are looked up at checkout time from `pod_variants` (after P1 seed). Pre-denormalising them avoids a join in the fulfilment mapper.

**SKU resolution rule:**
```
framed=false              → GLOBAL-FAP-{suffix}
framed=true, mount=false  → GLOBAL-CFP-{suffix}
framed=true, mount=true   → GLOBAL-CFPM-{suffix}
suffix: 30x40→12X16, 50x70→20X28, 70x100→28X40
```

---

## 4. PrintDesign shape

```typescript
export interface PrintDesign {
  id: string                        // e.g. 'fap01'
  category: 'fine-art-prints'
  num: string
  image: string
  gallery?: string[]
  noteIndex: number
  sizes: PrintSize[]
  frameColours: PrintFrameColour[]  // colours offered for this design (framed only)
  mountAvailable: boolean           // whether this design offers passe-partout
  published: boolean
  fromPLN: number                   // display "from" price
}
```

`paper` and old `frames` arrays removed. `framed` is always offered when `frameColours.length > 0`.

---

## 5. Pricing

`src/lib/print-pricing.ts` — same base-per-size model as `claude/prints-feature`, new axis names:

```typescript
const SIZE_BASE: Record<PrintSize, Money> = {
  '30x40': { pln: 105, eur: 25, gbp: 22 },
  '50x70': { pln: 150, eur: 35, gbp: 30 },
  '70x100': { pln: 190, eur: 45, gbp: 38 },
}
const FRAMED_DELTA: Money = { pln: 0, eur: 0, gbp: 0 }   // TBD with studio
const MOUNT_DELTA:  Money = { pln: 0, eur: 0, gbp: 0 }   // TBD with studio

export function priceOfVariant(sel: PrintVariantSelection, currency: 'pln' | 'eur' | 'gbp'): number
```

Deltas are zero placeholders — update when studio confirms margins. All zero is safe for MVP (keeps pricing identical to unframed).

---

## 6. Database migrations

Three new migrations on top of the ported `20260613120000_order_items_variant.sql`:

**`20260626120001_pod_variants.sql`**
```sql
create table pod_variants (
  id                   uuid primary key default gen_random_uuid(),
  prodigi_sku          text not null unique,
  display_size_label   text not null,
  frame_colour         text not null,
  mount_enabled        boolean not null,
  paper                text not null default 'EMA',
  print_area_width_px  integer,
  print_area_height_px integer,
  active               boolean not null default true,
  last_synced_at       timestamptz
);
alter table pod_variants enable row level security;
alter table order_items add column pod_variant_id uuid references pod_variants(id);
```

**`20260626120002_fulfilment_jobs.sql`**
```sql
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
create unique index fulfilment_jobs_order_unique
  on fulfilment_jobs(order_id) where status not in ('cancelled','failed_action_required');
alter table fulfilment_jobs enable row level security;

create table prodigi_orders (
  id                    uuid primary key default gen_random_uuid(),
  order_id              uuid not null references orders(id),
  prodigi_order_id      text unique,
  prodigi_status_stage  text,
  prodigi_raw_json      jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
alter table prodigi_orders enable row level security;
```

**`20260626120003_webhook_events.sql`**
```sql
create table webhook_events (
  id                uuid primary key default gen_random_uuid(),
  provider          text not null,
  provider_event_id text,
  event_type        text,
  status            text not null default 'processing',
  raw_json          jsonb,
  processing_started_at timestamptz,
  processed_at      timestamptz,
  created_at        timestamptz not null default now()
);
create unique index webhook_events_dedup
  on webhook_events(provider, provider_event_id) where provider_event_id is not null;
alter table webhook_events enable row level security;
```

---

## 7. Module structure

New files (all Prodigi/fulfilment — no overlap with existing storefront):

```
src/server/prodigi/
  client.ts       # fetch wrapper: X-API-Key, sandbox/live URL, typed errors, retryability
  types.ts        # plain TS request/response types for /orders, /products/{sku}, /quotes
  mapper.ts       # local order + items + pod_variants → Prodigi POST /orders payload
  callbacks.ts    # CloudEvents parse, token validation, dedup upsert, re-fetch order state

src/server/fulfilment/
  enqueue.ts      # insert fulfilment_jobs row + push to FULFILMENT_QUEUE
  process-job.ts  # queue consumer: verify paid → map → POST /orders → persist

src/app/api/webhooks/prodigi/route.ts   # Prodigi callback endpoint

scripts/
  sync-prodigi-skus.ts   # GET /products/{sku} for all 21 SKUs → upsert pod_variants
```

Storefront files (updated from ports):
```
src/lib/types.ts              # new print types (replace old)
src/lib/print-cart.ts         # new 6-part token (replace old)
src/lib/prints.ts             # new PrintDesign shape (replace old)
src/lib/print-pricing.ts      # new axes (replace old)
src/lib/checkout.ts           # validateCart updated (port + update)
src/app/api/checkout/route.ts # CheckoutVariant updated (port + update)
```

---

## 8. Webhook flow (updated)

Inside `handleStripeEvent` → `payment_intent.succeeded`:

```
markPaid           (unchanged — uses countCeramicOrderItems from fulfillment.ts ✅)
trackPurchase      (unchanged)
ensureInvoiced     (ported from prints-feature — handles print line items ✅)
createShipment     ONLY when order has ceramic items (variant IS NULL)   ← ADD GUARD
enqueueProdigi     ONLY when order has print items (variant IS NOT NULL)  ← NEW
```

`createShipment` guard pattern (one DB read, before the branching):
```typescript
const { data: items } = await supabase
  .from('order_items').select('variant').eq('order_id', orderId)
const hasCeramics = items?.some(i => i.variant === null)
const hasPrints   = items?.some(i => i.variant !== null)
if (hasCeramics) await createShipment(...)
if (hasPrints)   await enqueueProdigi(...)
```

`enqueueProdigi` inserts a `fulfilment_jobs` row (idempotent via unique constraint) then pushes to `FULFILMENT_QUEUE`. If the Queue binding is absent (local dev without wrangler), it falls back to `ctx.waitUntil(processJob(...))` and swallows errors — never throws from the webhook handler.

---

## 9. Cloudflare Queue + R2

**wrangler.jsonc additions:**
```jsonc
"queues": {
  "producers": [{ "binding": "FULFILMENT_QUEUE", "queue": "prodigi-fulfilment" }],
  "consumers": [{
    "queue": "prodigi-fulfilment",
    "max_batch_size": 1,
    "max_retries": 10,
    "dead_letter_queue": "prodigi-fulfilment-dlq"
  }]
},
"r2_buckets": [{ "binding": "PRINT_ASSETS", "bucket_name": "anna-ciok-print-assets" }]
```

**cloudflare-env.d.ts additions:**
```typescript
FULFILMENT_QUEUE: Queue
PRINT_ASSETS: R2Bucket
PRODIGI_API_KEY_SANDBOX: string
PRODIGI_API_KEY_LIVE: string
PRODIGI_ENV: string
PRODIGI_CALLBACK_TOKEN: string
PRINT_ASSET_TOKEN_SECRET: string
```

Run `npm run cf-typegen` after updating.

**worker.ts additions:**
```typescript
export default {
  fetch: handler.fetch,
  scheduled: handler.scheduled,
  async queue(batch, env, ctx) {
    for (const msg of batch.messages) {
      await processJob(msg.body, env, ctx)
        .then(() => msg.ack())
        .catch(err => { err?.retryable === false ? msg.ack() : msg.retry() })
    }
  }
}
```

**Asset URL:** R2 presigned GET generated in `process-job.ts` at consumer execution time (not at checkout). TTL = 7 days. Log job ID only — never log the signed URL.

---

## 10. Prodigi callback endpoint

`POST /api/webhooks/prodigi/{PRODIGI_CALLBACK_TOKEN}`

1. Validate token in URL path — 401 if wrong.
2. Parse CloudEvents body — 400 if `id`, `type`, or `data.prodigiOrderId` missing.
3. Upsert `webhook_events(provider='prodigi', provider_event_id=cloudEvent.id, status='processing', processing_started_at=now())`. On conflict: 200 if already `done`; 200 if `processing` and `processing_started_at > now() - 5m`; reacquire if stale.
4. Re-fetch order from `GET /orders/{prodigiOrderId}` — never trust callback payload state.
5. Update `prodigi_orders` + `fulfilment_jobs` status via `status-map.ts`.
6. Set `webhook_events.status='done'`, `processed_at=now()`.
7. Return 200 only after step 6. Transient errors → 500 (Prodigi retries). Non-retryable → 400.
8. Never overwrite a terminal status (`completed`, `cancelled`, `failed_action_required`).

---

## 11. .env.example additions

```bash
PRODIGI_API_KEY_SANDBOX=             # from Prodigi dashboard → API keys
PRODIGI_API_KEY_LIVE=                # from Prodigi dashboard → API keys (live)
PRODIGI_ENV=sandbox                  # switch to "live" only after full checklist
PRODIGI_CALLBACK_TOKEN=              # generate: openssl rand -hex 32
PRINT_ASSET_TOKEN_SECRET=            # generate: openssl rand -hex 32
PRODIGI_DEFAULT_SHIPPING_METHOD=Budget
```

---

## 12. Tests

**Port from `claude/prints-feature` (update for new axes):**
- `src/lib/fulfillment.test.ts` — ceramic count guard
- `src/lib/checkout.test.ts` — print token validation branch
- `src/lib/print-cart.test.ts` — token encode/decode
- `src/lib/print-pricing.test.ts`
- `src/lib/prints.test.ts`
- `src/lib/marketing/conversions.test.ts`

**New:**
- `src/server/prodigi/client.test.ts` — error classification, sandbox/live URL, retryability
- `src/server/prodigi/mapper.test.ts` — payload shape, idempotency key, recipientCost per currency
- `src/server/fulfilment/process-job.test.ts` — paid-only guard, duplicate guard, asset URL resolution
- `src/app/api/webhooks/prodigi/route.test.ts` — CloudEvents parse, dedup, terminal-status guard

**Regression gate:** `markPaid` count guard test (`IS NULL`) must pass for ceramic-only, print-only, and mixed scenarios. `createShipment` mock must confirm it's never called for print-only orders.

---

## 13. Open PR cleanup (on merge)

When `feat/fine-art-prints-prodigi` is ready to merge:
- Close PR #97 (`claude/prints-feature`) — superseded; delete branch
- Close PR #82 (`claude/wizardly-lalande-14194d`) — variant_key migration subsumed into new branch migrations; delete branch
- Close PR #80 (`codex/fine-art-prints-plan`) — planning doc outdated; delete branch

---

## 14. Out of scope (Phase 6 / later)

- Limited-edition print stock (`print_stock` table, `claim_print_units()`)
- Admin CRUD for print designs
- Paper selector (fixed EMA at MVP)
- Mount colour selector (fixed Snow white at MVP)
- Automated margin monitoring via `POST /quotes`
- Multi-provider fulfilment

---

## 15. Live cutover checklist

Do not set `PRODIGI_ENV=live` until all items checked:

- [ ] Live API key set as Worker secret
- [ ] All 21 SKUs verified via live `GET /products/{sku}` — printAreaSizes + shipsTo PL/EU/GB
- [ ] Pricing verified against live Prodigi quotes
- [ ] R2 presigned URL tested with 7-day TTL on live bucket
- [ ] Full sandbox order smoke test passed (place → Prodigi order created → callback → status updated)
- [ ] Duplicate webhook delivery test passed (idempotency)
- [ ] Duplicate queue delivery test passed (idempotency)
- [ ] `createShipment` not called on print-only order (verified in smoke test)
- [ ] Admin shows Prodigi order ID + stage
- [ ] Cancellation path documented (Prodigi actions API)
