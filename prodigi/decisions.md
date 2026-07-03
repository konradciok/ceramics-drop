# Prodigi Integration — Decisions Log

> Started: 2026-06-26
> Read `masterprompt.md`, `phases.md`, and `sku-catalog.md` first.

---

## P0-1 — SKU / variant verification ✅

**Status:** Complete (2026-06-26). Verified against live Prodigi sandbox API locally.

**Blocker resolved:** `PRODIGI_API_KEY_SANDBOX` in `.dev.vars`; API reachable from dev machine.

**Deliverable:** `prodigi/sku-catalog.md` — full 21-variant matrix with print-area pixels.

---

## P0-4 — Open questions

### Q1 — Variant axes ✅

**Decision (2026-06-26):**

```typescript
export type PrintSize = '30x40' | '50x70' | '70x100'
export type PrintFrameColour = 'black' | 'white' | 'natural'
// framed + mount are booleans; mount only applies when framed=true
```

| Axis | Store values | Prodigi mapping |
|---|---|---|
| Size | 30×40, 50×70, 70×100 cm | SKU suffix `12X16`, `20X28`, `28X40` |
| Framed | yes / no | `GLOBAL-FAP` vs `GLOBAL-CFP` / `GLOBAL-CFPM` |
| Passe-partout | yes / no (framed only) | `CFP` vs `CFPM` |
| Frame colour | biały, czarny, natural (framed only) | `attributes.color`: `white`, `black`, `natural` |

21 combinations per artwork. See `sku-catalog.md`.

**API findings vs original masterprompt:**

- Frame colours: **8 available in API**, store offers **3** (black, white, natural).
- Paper: Prodigi uses `EMA` (not `enhanced-matte` string) — fixed at MVP.
- Mount colour: API exposes only `Snow white` for `CFPM` — fixed at MVP.
- 50×70 and 70×100 have no exact cm SKU names; nearest inch ladders `20X28` (51×71) and `28X40` (71×102). All ship to PL.

---

### Q2 — Asset hosting ✅

**Decision (2026-06-26):** **Cloudflare R2** for high-res print masters.

| Layer | Role |
|---|---|
| `public/uploads/` | Display WebP only (existing storefront tiles) |
| **R2 bucket** | Print masters at fulfilment resolution (per `sku-catalog.md` px) |

**Fulfilment URL:** R2 **presigned GET** passed to Prodigi in `assets[].url` at order time. TTL must cover queue retry window (generate fresh presign in the queue consumer, not at checkout).

**Infra (Phase 1/3):** R2 bucket binding in `wrangler.jsonc`, upload workflow (manual script or admin). No Worker streaming proxy for MVP.

**Constraint:** Prodigi fetches the asset when the job runs; presigned URL must be valid at consumer execution time.

---

### Q3 — Queue vs direct ✅

**Decision (2026-06-26):** **Cloudflare Queue** (`FULFILMENT_QUEUE`).

`payment_intent.succeeded` webhook → enqueue `FulfilmentJobMessage` → queue consumer calls Prodigi `POST /orders`.

**Why not inline / `ctx.waitUntil`:** Stripe webhook must return quickly (~20 s); Prodigi order creation + asset URL generation can exceed that; at-least-once retries belong on the queue, not on Stripe webhook redelivery.

**Not** OpenNext `DOQueueHandler` — that is cache invalidation, not fulfilment (see `masterprompt.md`).

---

### Q4 — Ceramics vs prints (fulfilment & product) ✅

**Decision (2026-06-26):** **Ceramics and prints are separate businesses on the same site — not mixed.**

| | Ceramics | Prints |
|---|---|---|
| **Audience** | Drop buyers (limited runs) | Print buyers (ongoing) |
| **Catalogue** | Not permanently on sale; drop model | Permanent print catalogue |
| **Fulfilment** | InPost ShipX (Paczkomat / Kurier / Odbiór) | Prodigi labs ship directly to customer |
| **Cart** | Ceramic IDs only | Print tokens only — **no mixed cart** |

**Implications:**

- Checkout validates one product line per order type (print-only or ceramic-only). No `purchase-mixed` path in MVP.
- `createShipment` (InPost) runs only when `order_items` contain ceramic rows (`variant is null`). Print orders never hit InPost.
- Print shipping method is Prodigi tier (`Budget` default) on the Prodigi order `recipient` — not InPost Geowidget.
- UI copy: prints ship from Prodigi's print partner; ceramics ship via InPost when a drop is live. No “two parcels in one order” messaging needed because orders don't combine both.

**InPost guard** in `webhook.ts` remains required for legacy ceramic orders until ceramics are fully wound down.

---

### Q5 — Storefront token format ✅

**Decision (2026-06-26):**

```text
print:{designId}:{size}:{framed}:{mount}:{frame_colour}
```

- `size`: `30x40` | `50x70` | `70x100`
- `framed`: `true` | `false`
- `mount`: `true` | `false` (ignored when `framed=false`; encode as `false`)
- `frame_colour`: `black` | `white` | `natural` | `none` (when unframed)

Replaces the `claude/prints-feature` plan token `print:id:size:paper:frame`. No application code on `main` consumes the old format yet (branch is planning-only).

**`order_items.variant` JSON shape:**

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

`prodigiSku` and `printAreaPx` are denormalised at add-to-cart from `sku-catalog` lookup — source of truth remains `pod_variants` after P1 sync.

---

## Changelog

| Date | Item |
|---|---|
| 2026-06-26 | P0-1 complete; sku-catalog.md created |
| 2026-06-26 | Q1 + Q5 decided (3 sizes, framed/mount/colour model, cart token) |
| 2026-06-26 | Q2 R2 · Q3 CF Queue · Q4 separate ceramics/prints, no mixed cart |
