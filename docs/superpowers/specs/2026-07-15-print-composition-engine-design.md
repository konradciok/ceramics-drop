# Smart Print-Variant Composition Engine — Design

- **Date:** 2026-07-15
- **Status:** Draft — pending review
- **Topic:** Layered composition of fine-art print derivatives (artwork + background + signature)
- **Related:** `docs/plans/print-asset-pipeline.md`, `docs/print-asset-runbook.md`,
  `docs/superpowers/specs/2026-06-26-fine-art-prints-prodigi-design.md`

## Context / Problem

The print-asset pipeline (`scripts/print-assets-*`) currently takes a single **hand-authored,
already-flattened master** and crops/resizes it into exact Prodigi print-area derivatives. The master
is produced *outside* the system (e.g. `design/prints/fap01-master.tif`) and merely cropped per size.

The studio's pain is a **quality problem on a small number of designs, not throughput**: flattened
masters have composition issues — optical centering, signature scaling, and margin proportions — and
each design needs careful, per-artwork layer-based control. Today that control happens upstream in a
manual flatten step that is slow to iterate on and hard to keep deterministic across the 3 print sizes.

**Goal:** move the composition (artwork + background/border + signature as independent layers) into the
codebase as a parametric, deterministic step that renders each print-area profile directly — a sibling
to `prepare` whose output flows straight into the *existing* upload/verify/publish machinery, never
re-cropped — no rebuild of the downstream R2/DB/publish/SKU machinery.

**Non-goals (YAGNI for a few designs):**
- Layout "families" auto-selected by aspect ratio (one tuned config per design is enough).
- A persisted, CMS-style versioned layout store (JSON-in-repo matches the existing
  `config/print-assets/` pattern).
- A live admin UI in the first cut (deferred — see Phase 2).
- Automatic bleed handling (the Prodigi print area *is* the bleed edge; there is no separate bleed
  concept in the code today).

## Current state (what already exists — do not rebuild)

The proposal's flow is ~70% implemented as CLI scripts; only the composition step is missing.

- **`sharp@0.34.5`** (devDep, isolated to `scripts/`) — natively does `.composite()` (overlay artwork +
  signature), `.extend()` (background/border fill), `resize({fit:'contain'})`, and rasterizes SVG input.
  **No new image dependency required.** The one sharp consumer today is `scripts/lib/prepare-derivatives.ts`.
- **prepare → publish backend** (all in `scripts/`): `print-assets-prepare.ts` (enumerate active
  variants → dedupe to distinct print-area profiles via `distinctProfiles` in `src/lib/print-assets-prepare.ts`
  → crop/resize to exact Prodigi pixels → write `manifest.json` + `proof-{profile}.jpg` contact sheet),
  `-upload` (R2 content-addressed keys + stage rows), `-verify` (SHA-256 + dimension match → `ready`),
  `-publish` (atomic `publish_print_asset_revision()` RPC), `-sandbox-matrix` (**one real Prodigi sandbox
  order per profile** — the physical-QA gate), `-gallery` (storefront WebPs).
- **DB** — `print_fulfilment_assets` (immutable after staging, content-addressed), the
  `publish_print_asset_revision()` RPC, `product_variants.print_area_*_px`.
- **SKU linkage** — already automatic: `variantKey → PRODIGI_SKU_MAP` (`src/lib/print-cart.ts`) yields
  `{sku, printAreaPx}`. Nothing for an operator to wire.
- **Prodigi contract** — `fillPrintArea` onto exact pixel grids; 3 sizes × 3 mountings deduped to a few
  profiles (e.g. 3600×4800, 6000×8400, 8400×12000 @300DPI). Frame/mount are **order-item attributes,
  not baked into the image.**

## Design — Phase 1 (MVP): parametric composer

A deterministic sharp-based composition step, configured per product by a JSON file, that renders each
distinct print-area profile at exact Prodigi pixels (+ preview proofs) and hands off to the unchanged
upload/verify/publish pipeline.

### Layer model

Separate, independently positioned layers (never a flattened source):

- **Artwork** — the scanned/photographed piece (PNG/TIF, may have transparency).
- **Background** — a single solid colour, always `#ded9c3`, filling the canvas behind the artwork.
  Generated in-code by sharp (canvas fill) — **not a stored file**. It's a default constant in
  `src/lib/print-composition.ts`, optionally overridable per product in the config.
- **Signature** — one shared SVG, `config/print-composition/signature.svg`, reused across all prints,
  as its own layer. SVG scales crisply at every print size.

### Layout engine (`src/lib/print-composition.ts`, pure / I/O-free)

All geometry expressed as **fractions of the print area** and resolved to pixels at 300 DPI, so the same
config renders correctly at every size. Keep this module pure so it unit-tests like the existing
validators in `src/lib/print-assets-prepare.ts`.

- `contain` fit for the artwork (whole piece always visible; never `cover`).
- Proportional margins, clamped to physical mm bounds: `margin = clamp(shortSide * k, 18mm, 55mm)`.
- Dedicated signature zone: `signatureHeight = clamp(canvasH * 0.028, 8mm, 20mm)`,
  `signatureGap = clamp(canvasH * 0.022, 8mm, 22mm)`.
- **Optical offset** — per-artwork `opticalOffset {x,y}` (fractions) to correct mathematical-vs-optical
  centering, plus optional `focalPoint`. This is the primary fidelity lever.

### Config schema — `config/print-composition/{productId}.json`

Beside the existing `config/print-assets/{id}.json`. Matches `parseCompositionConfig` in
`src/lib/print-composition.ts` — `product`, `artwork`, `signature` required, the rest defaults.
`signature` is a plain repo-relative path (no `align` knob — the signature is always horizontally
centred):

```jsonc
{
  "product": "fap01",
  "artwork": "design/prints/fap01-artwork.tif",
  "background": "#ded9c3",
  "signature": "config/print-composition/signature.svg",
  "layout": {
    "marginShortSideFrac": 0.065,
    "artworkMaxWidthFrac": 0.85,
    "artworkMaxHeightFrac": 0.76,
    "signatureHeightFrac": 0.028,
    "signatureGapFrac": 0.022
  },
  "opticalOffset": { "x": -0.012, "y": -0.006 }
}
```

### Pipeline integration

The composer (`scripts/lib/compose-master.ts` + CLI `scripts/print-assets-compose.ts`,
`npm run print-assets:compose --product <id>`) is a **sibling to `prepare`**, not a feeder into it. It
enumerates active variants (`activeVariantDimensions`) → dedupes to distinct profiles
(`distinctProfiles`) → renders each profile's exact-pixel composed derivative (bg + artwork `contain` +
signature) → writes derivatives + a **prepare-compatible `manifest.json`** (via `buildManifest`) +
`proof-{profile}.jpg` contact sheets into the same `design/print-assets/{id}/{rev}/` layout. Downstream
`print-assets:upload/verify/publish` read only the manifest + named files, so they are **unchanged** —
a drop-in alternative generator. `config/print-assets/{id}.json`'s per-profile `crop` entries go unused
for composed products; its `gallery` section still applies (consumed by `print-assets:gallery`).

### Tuning loop (no UI)

Edit `config/print-composition/{id}.json` → re-run `print-assets:compose` → inspect the regenerated
`proof-*.jpg` → repeat. Then `sandbox-matrix` a physical Prodigi order to QA the print. This serves the
quality goal directly; the iteration is with the artist.

## Design — Phase 2 (deferred): interactive admin UI

Only if the JSON tune-rerun loop proves painful for the artist. Build on existing primitives
(`useAdminAction`, `ConfirmModal`, `.adm-detail-layout` for a preview+controls split). Greenfield parts:

- Live `<canvas>` side-by-side preview across sizes.
- Range sliders (scale, X, Y) + colour picker — new `.adm-slider` CSS.
- Browser image upload + a **new `/api/admin/compose/*` route that writes to the `env.PRINT_ASSETS` R2
  binding** (no in-app R2 write path exists today; current writes are CLI-only via wrangler shells).

Consider a **local dev-only preview page** before the gated production admin — it covers the tuning loop
at a fraction of the access/auth cost.

## Effort estimate

| Chunk | What | Size | ~Eng-days | Phase |
|-------|------|------|-----------|-------|
| A | Composition/layout engine (pure math + sharp composite/extend/resize) | M | 2–4 | 1 |
| B | Layer/config schema + per-product `config/print-composition/{id}.json` + types | S | 0.5–1 | 1 |
| C | Wire composer into the existing pipeline (per-profile derivatives + prepare-compatible manifest → upload/verify/publish) | S | 1 | 1 |
| D | Preview proof of the composed result (reuse `proof-{profile}.jpg` pattern) | S | 0.5 | 1 |
| E | Interactive admin UI (canvas preview + sliders + upload + R2-write route + approve) | L | 5–8 | 2 |

**Phase 1 (A–D): ~3–6 engineering days.** Phase 1+E: ~8–14 days. Because the goal is quality,
iteration-with-the-artist time dominates, not code — budget ~1 extra day per additional tuning round.

## Resolved decisions

1. **Background** — always plain `#ded9c3`, one colour. **Generated in-code by sharp at the target
   canvas size** (canvas fill); no background image is stored. It's a default constant in
   `src/lib/print-composition.ts` (overridable per product, but expected to stay `#ded9c3`). This is a
   printed faux-matte margin inside the Prodigi print area — distinct from the physical `mount` SKU.
2. **Composition mode — per-profile.** The composer renders each distinct print-area profile's exact
   canvas independently (bg fill → artwork via `contain`, always fully visible → signature placed
   relative to that canvas), at exact Prodigi pixels. Required because active profiles span multiple
   aspect ratios (fap01: 3:4, 5:7, 7:10, 2:3) — a single master cropped per profile would re-crop the
   artwork per size (today's manual-placeholder pain). Layout is defined once as fractions and applied
   per profile, eliminating per-size crop authoring. The composer is a **sibling to `prepare`**, not a
   feeder into it: it produces a prepare-compatible `manifest.json`, so `upload`/`verify`/`publish` are
   unchanged.
3. **Signature** — a single shared SVG, reused by every print, tracked in the repo at
   `config/print-composition/signature.svg`. Lives under `config/` (tracked) rather than `design/`
   (gitignored) because it's a small, stable brand asset that should be version-controlled, not lost
   with the untracked master files. The per-product config references it by that path.

## Verification

- **Unit (Vitest):** pure layout math in `src/lib/print-composition.ts` — `contain` scale, margin
  clamp bounds, signature-zone sizing/position, optical-offset application. Style mirrors existing
  `print-assets-prepare.ts` validator tests.
- **End-to-end on one design:** `npm run print-assets:compose --product fap01` → inspect the
  per-profile derivatives + `proof-*.jpg` → existing `upload/verify/publish` →
  `npm run print-assets:sandbox-matrix --product fap01` for a real Prodigi sandbox order per profile
  (the physical fidelity gate).
- **Repo gates:** `npm run typecheck`, `npm run test`, `npm run lint`.

## Critical files (Phase 1)

- New `src/lib/print-composition.ts` — pure layout math + types.
- New `scripts/lib/compose-master.ts` — sharp composition module (beside
  `scripts/lib/prepare-derivatives.ts`).
- New `scripts/print-assets-compose.ts` + `print-assets:compose` in `package.json`.
- New `config/print-composition/{productId}.json` — layer/layout config.
- `config/print-assets/{id}.json` — per-profile `crop` entries go unused for composed products; the
  `gallery` section still applies.
