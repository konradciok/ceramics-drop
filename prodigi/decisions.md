# Prodigi Integration — Decisions Log

> Started: 2026-06-26
> Read `masterprompt.md` and `phases.md` first.
> This file records decisions for the 5 open questions (P0-4) and the findings
> from P0-1 (SKU / variant verification).

---

## ⛔ BLOCKER — P0-1 cannot be completed as specified in this environment

P0-1 requires verifying SKUs against the **live Prodigi sandbox API**
(`GET /products/GLOBAL-CFP-12X16`, `GET /products/GLOBAL-CFPM-12X16`, etc.) to
read authoritative `printAreaSizes` (pixels @ 300 DPI), `shipsTo`, and the exact
`attributes` enum values. **This is not currently possible here:**

1. **No API key.** There is no `PRODIGI_API_KEY_SANDBOX` (or any Prodigi key) in
   the environment, in `.dev.vars` (the file does not exist), or in `.env.example`.
   The sandbox API requires an `X-API-Key` header.

2. **Egress policy denies the host.** Outbound HTTPS to `api.sandbox.prodigi.com`
   is rejected by the organization's egress proxy:

   ```text
   connect_rejected — gateway answered 403 to CONNECT (policy denial)
   host: api.sandbox.prodigi.com:443
   ```

   The proxy README is explicit: report blocked hosts, do not route around them.
   `www.prodigi.com` and `support.prodigi.com` also return 403 to server-side
   fetch (bot protection), so even the public docs pages can't be scraped directly.

### What is needed to unblock P0-1 (ACTION REQUIRED)

- [ ] A **Prodigi sandbox API key** (`PRODIGI_API_KEY_SANDBOX`) placed in
      `.dev.vars` locally — never committed.
- [ ] The egress allowlist extended to permit `api.sandbox.prodigi.com`
      (and later `api.prodigi.com` for the live cutover).

Until both are in place, the `printAreaSizes` pixel dimensions and the exact
`attributes` enum strings below are **PROVISIONAL** (sourced from public Prodigi
documentation, not the API). The 18-variant matrix in `sku-catalog.md` must be
re-derived from real `GET /products/{sku}` responses before any mapper / asset
sizing code (Phase 3) is written. **Phase 1 DB schema can proceed**, but the
`pod_variants` seed values must be treated as placeholders until the sync script
(`P1-3`) runs against the real API.

---

## Findings from public Prodigi documentation (PROVISIONAL — not API-verified)

Sources: Prodigi product range & support pages (web search, 2026-06-26):
- Classic frames product page: `https://www.prodigi.com/products/framed-prints/classic-frames/`
- Classic frames spec PDF: `https://www.prodigi.com/download/product-range/Prodigi Classic frames.pdf`
- Frames support article: `https://support.prodigi.com/hc/en-us/articles/13137070879772`
- Print API reference: `https://www.prodigi.com/print-api/docs/reference/`

### SKU families (confirms the masterprompt's core thesis)

- **`GLOBAL-CFP-{SIZE}`** — Classic Frame Print, **no mount**. Print area ≈ full
  glazing size.
- **`GLOBAL-CFPM-{SIZE}`** — Classic Frame Print **with mount** (passe-partout).
  Print area = the mount aperture/window, **smaller than the frame size**.

This confirms mount is a **separate SKU family / axis**, NOT a UI boolean on one
SKU. ✅ The masterprompt's reconciled model is correct on this point.

- Example confirmed: **`GLOBAL-CFPM-12X16`** is recommended for an **8×12"** image
  (i.e. the 12×16" glaze size with a 2" mount yields an ~8×12" aperture).
  Other documented mounted recommendations: `GLOBAL-CFPM-16X20` → 12×16" image;
  `GLOBAL-CFPM-20X28` → 16×24" image.
- The size label (e.g. "12×16") = the **glaze/exterior** size, **not** the image
  area. Mount widths: ≤10×10" → 1"; ≤11×14" → 1.5"; ≥12×16" → 2".

### Frame colours (more than the masterprompt assumed)

Public docs list **8** classic frame colours:
`black`, `white`, `natural`, `antique silver`, `brown`, `antique gold`,
`dark grey`, `light grey`.

➡️ The masterprompt/phases assume only `black | white | natural`. That subset is a
**reasonable MVP curation**, but the exact API `attributes.color` enum strings
(capitalisation, "natural" vs "oak", hyphenation) **must be read from the API**.
**Decision needed (Q1):** confirm we ship the 3-colour MVP subset.

### Mount colours

Public docs list **3** mount colours: `snow white`, `black`, `hayseed`.
The masterprompt fixes mount colour at `snow_white` for MVP — consistent with docs.

### Paper / glazing (⚠️ discrepancy with masterprompt)

Public docs say Classic frames use **"fine art paper"** and **Perspex** glaze by
default (glaze options: Perspex, float glass, moth-eye).

➡️ The masterprompt/phases hardcode `paper: 'enhanced-matte'`. The Classic Frame
public copy says "fine art paper", and Enhanced Matte may or may not be a valid
`attributes.paperType` value for CFP/CFPM. **This must be confirmed from the API
`attributes` block.** Do not assume `enhanced-matte` is valid for these SKUs until
the API confirms it. (`pod_variants.paper` default left as a placeholder.)

**Schema guidance (P1-1 / P1-3):** to avoid a Prodigi `4xx` at fulfilment time
from an unverified paper value, seed `pod_variants` rows with **`active = false`**
(and treat `paper` as not-yet-trusted) until `scripts/sync-prodigi-skus.ts` has
read the real `attributes.paperType` enum from `GET /products/{sku}` and flipped
the verified rows to `active = true`. **Phase 3 mapper tests must assert against
API-verified attribute values, not web-search guesses.** (Reconciled with Cursor
review on PR #99.)

### Sizes

Public range: **6×6" up to 40×40"**, inch-based ladder. The masterprompt's
candidate MVP ladder is `12×16`, `16×20`, `18×24`. Exact available size SKUs and
their `printAreaSizes` (px) per family **must come from the API**.

### `printAreaSizes` (px @ 300 DPI)

**NOT AVAILABLE from public docs** — these come only from
`GET /products/{sku}.product.variants[].printAreaSizes`. Blocked (see above).

---

## The 5 open questions (P0-4)

> Per the execution rules, P1 cannot start until these 5 are answered. Q1 is
> partially blocked on live-API access; Q2–Q5 are answerable now and recommended
> defaults are proposed below for sign-off.

### Q1 — Variant axes (sizes / frame colours / mount / paper)

**Status: BLOCKED on live API** for exact enum strings + print-area px.
Provisional from public docs:
- **Sizes (MVP):** 3 sizes — proposed `12×16`, `16×20`, `18×24` (inches). Confirm
  these exact SKUs exist for both CFP and CFPM via API.
- **Frame colours (MVP):** `black | white | natural` (subset of 8 available).
- **Mount:** `false` (CFP) / `true` (CFPM) — confirmed as separate SKU families.
- **Mount colour:** fixed `snow white` for MVP.
- **Paper:** ⚠️ masterprompt says `enhanced-matte`; docs say Classic = "fine art
  paper". **Confirm valid `paperType` from API before seeding `pod_variants`.**
- **Glazing:** fixed Perspex for MVP.

➡️ **DECISION NEEDED FROM OWNER:** (a) provide sandbox key + egress allowlist so
the above can be API-verified; (b) confirm the 3-size × 3-colour MVP curation.

### Q2 — Asset hosting

(To be decided — see masterprompt "Asset handling". Recommendation pending Q1.)

### Q3 — Queue vs direct

(To be decided — Cloudflare Queue vs `ctx.waitUntil` inline.)

### Q4 — Shipping for framed prints

(To be decided — Prodigi ships prints directly from its labs, separate from
InPost; mixed orders = two parcels. UX copy decision.)

### Q5 — Storefront token format migration

(To be decided — audit consumers of the old `print:id:size:paper:frame` token on
`claude/prints-feature` before changing the format.)

> Q2–Q5 will be filled in with recommended decisions in the P0-4 sub-task, which
> per the execution rules is a STOP-and-report point. Q1's API-verification half
> is blocked now and is reported above ahead of schedule because it gates P0-1.
