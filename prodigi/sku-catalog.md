# Prodigi SKU Catalog — Fine Art Prints (Anna Ciok)

> Verified: 2026-06-26 via Prodigi sandbox API (`GET /products/{sku}`)
> Environment: `api.sandbox.prodigi.com/v4.0`
> All SKUs below ship to **PL**.

## Storefront variant model (agreed)

| Axis | Values | Notes |
|---|---|---|
| `size` | `30x40` · `50x70` · `70x100` | Display labels (cm) |
| `framed` | `true` · `false` | `false` = loose fine art print (`GLOBAL-FAP`) |
| `mount` | `true` · `false` | Passe-partout; **only when `framed=true`** |
| `frame_colour` | `black` · `white` · `natural` | **Only when `framed=true`**; maps to Prodigi `attributes.color` |

**Combinatorics:** 3 unframed + 3 sizes × 3 colours × 2 mount states = **21 fulfilment variants** per artwork.

**Cart token:** `print:{designId}:{size}:{framed}:{mount}:{frame_colour}`

Examples:

- `print:fap01:30x40:false:false:none` — loose print 30×40
- `print:fap01:50x70:true:false:black` — framed, no passe-partout, black frame
- `print:fap01:70x100:true:true:natural` — framed, passe-partout, natural frame

**Paper (MVP):** fixed `EMA` (Enhanced Matte Art Paper, 200 gsm) — Prodigi `paperType`; not a customer-facing axis.

**Mount colour (MVP):** fixed `Snow white` when `mount=true` — only value exposed by API for `GLOBAL-CFPM-*`.

---

## Size ladder (store label → Prodigi suffix)

| Store `size` | Prodigi suffix | Glaze / sheet (API) | Marketing note |
|---|---|---|---|
| `30x40` | `12X16` | 30×40 cm (framed) / 30×41 cm (FAP) | Exact cm match for framed |
| `50x70` | `20X28` | 51×71 cm | Nearest Prodigi size (+1 cm each side) |
| `70x100` | `28X40` | 71×102 cm | Prodigi lists as 70×100 / 28×40; +1/+2 cm vs label |

> `GLOBAL-CFP-28X39` is an exact 70×100 cm framed SKU but **does not ship to PL** and has no `CFPM` variant — not used.

---

## SKU resolver (implementation reference)

```text
if not framed:
  sku = GLOBAL-FAP-{suffix}
  attributes = {}   # no frame colour

if framed and not mount:
  sku = GLOBAL-CFP-{suffix}
  attributes = { color: frame_colour }

if framed and mount:
  sku = GLOBAL-CFPM-{suffix}
  attributes = { color: frame_colour, mount: "2.4mm", mountColor: "Snow white" }
```

Suffix from `size`: `30x40→12X16`, `50x70→20X28`, `70x100→28X40`.

---

## Full variant matrix

Print areas are **authoritative from API** (`variants[].printAreaSizes.default` at 300 DPI). Asset pipeline must target these pixel dimensions per row.

### 30×40 cm (`12X16`)

| framed | mount | frame_colour | Prodigi SKU | Print area (px) | Glaze (cm) |
|---|---|---|---|---|---|
| no | — | — | `GLOBAL-FAP-12X16` | 3600×4800 | 30×41 sheet |
| yes | no | black | `GLOBAL-CFP-12X16` | 3614×4795 | 30×40 |
| yes | no | white | `GLOBAL-CFP-12X16` | 3614×4795 | 30×40 |
| yes | no | natural | `GLOBAL-CFP-12X16` | 3600×4800 | 30×40 |
| yes | yes | black | `GLOBAL-CFPM-12X16` | 2400×3600 | 30×40 |
| yes | yes | white | `GLOBAL-CFPM-12X16` | 2400×3600 | 30×40 |
| yes | yes | natural | `GLOBAL-CFPM-12X16` | 2400×3600 | 30×40 |

Passe-partout window ≈ 20×30 cm (5 cm border per Prodigi FAQ for frames ≥30×40).

> **Re-verified 2026-07-03** against the sandbox API: the per-colour print-area
> difference on `GLOBAL-CFP-12X16` is **real** — `black`/`white` report
> 3614×4795 px while `natural` (and all other colours) report 3600×4800 px.
> All other SKUs share one print area across colours. `PRODIGI_SKU_MAP` in
> `src/lib/print-cart.ts` matches the API exactly.

### 50×70 cm (`20X28`)

| framed | mount | frame_colour | Prodigi SKU | Print area (px) | Glaze (cm) |
|---|---|---|---|---|---|
| no | — | — | `GLOBAL-FAP-20X28` | 6000×8400 | 51×71 sheet |
| yes | no | black / white / natural | `GLOBAL-CFP-20X28` | 6000×8400 | 51×71 |
| yes | yes | black / white / natural | `GLOBAL-CFPM-20X28` | 4800×7200 | 51×71 |

Passe-partout window ≈ 41×61 cm.

### 70×100 cm (`28X40`)

| framed | mount | frame_colour | Prodigi SKU | Print area (px) | Glaze (cm) |
|---|---|---|---|---|---|
| no | — | — | `GLOBAL-FAP-28X40` | 8400×12000 | 71×102 sheet |
| yes | no | black / white / natural | `GLOBAL-CFP-28X40` | 8400×12000 | 71×102 |
| yes | yes | black / white / natural | `GLOBAL-CFPM-28X40` | 7200×10800 | 71×102 |

Passe-partout window ≈ 61×91 cm.

---

## Prodigi attributes (framed)

From `GET /products/GLOBAL-CFP-12X16` (representative):

| Attribute | CFP (no mount) | CFPM (mount) |
|---|---|---|
| `color` | black, white, natural (+ 5 others not offered in store) | same |
| `mount` | `No mount / Mat` | `2.4mm` |
| `mountColor` | — | `Snow white` only |
| `paperType` | `EMA` | `EMA` |
| `glaze` | `Acrylic / Perspex` | `Acrylic / Perspex` |

Store offers **3 of 8** frame colours. Remaining API colours (brown, gold, silver, dark grey, light grey) are out of scope for MVP.

---

## Order item payload sketch

```json
{
  "sku": "GLOBAL-CFPM-20X28",
  "copies": 1,
  "sizing": "fillPrintArea",
  "attributes": {
    "color": "natural",
    "mount": "2.4mm",
    "mountColor": "Snow white"
  },
  "assets": [{ "printArea": "default", "url": "https://…" }]
}
```

Use `fillPrintArea` only when the master asset matches the print-area aspect ratio exactly; otherwise pre-render to the pixel dimensions in this catalog.

---

## API verification command

```bash
export PRODIGI_API_KEY_SANDBOX=$(grep '^PRODIGI_API_KEY_SANDBOX=' .dev.vars | cut -d= -f2- | tr -d '\r')
curl -sS -H "X-API-Key: $PRODIGI_API_KEY_SANDBOX" \
  "https://api.sandbox.prodigi.com/v4.0/products/GLOBAL-CFPM-20X28" | jq '.product.productDimensions, .product.variants[0].printAreaSizes'
```
