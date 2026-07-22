# Proportional print-asset composition (prepare-step rewrite)

Status: Implemented on `feat/print-composition` (2026-07-17). Production
state: `fap01` has a published fulfilment revision (`2026-07-12-r1` — see
`docs/print-asset-runbook.md` § Cutover evidence); `fap02`/`fap03` have
tracked configs and locally prepared derivatives (`2026-07-19-r2`) but no
published revision yet (no ready assets or assignments in production);
`fap04` is a draft config with zero active variants. Operator-confirmed
scope: separate SVG signature layer + clean artwork-only masters.

**2026-07-21 update:** a later manifest-hardening pass extended and reshaped
the manifest this composition step writes — see "Manifest extension" below
for the schema as actually shipped (schema v2, with a `schemaVersion`
discriminator, tracked-config provenance, and a `rendererVersion` bumped
independently of the JSON shape). Every other section of this spec (Layout
model, resolution math, validation rules) is unchanged and still describes
the shipped behaviour.

Supersedes the per-profile crop model in
`docs/plans/print-asset-pipeline.md` § Settled Architecture 1 ("Require an
explicit crop/focal configuration for every distinct aspect ratio") for the
*generation* step only. Every downstream contract (R2 keys, immutable storage,
atomic publish RPC, checkout snapshot, signed route, fail-closed fulfilment)
is unchanged.

## Context

### The defect

Today every print derivative is produced by **cropping a single-layer master**
(`scripts/lib/prepare-derivatives.ts` → `generateDerivative`: `extract(crop)` →
`resize(fit:'fill')`). The master is a flattened photograph: painting + coloured
border/frame + signature, fused into one image. Each distinct Prodigi print-area
profile (`3600x4800`, `8400x12000`, …) gets its own explicit crop region in
`config/print-assets/{productId}.json`.

Because the border is part of the image being cropped, **any adaptation to a
different aspect ratio distorts the border unevenly**. A crop that preserves the
full border top/bottom necessarily trims it on the sides (or vice versa). There is
no crop of a flattened rectangle that preserves proportional margins on all four
sides when the target aspect differs from the source. Contain-fitting the
flattened master is no escape: it double-borders or letterboxes. The border and
the artwork must be separated.

### Operator requirement (verbatim intent)

Artwork size, margins, and position relative to the whole format must be defined
**proportionally (fractions)**, not in constant pixels. Every Prodigi variant —
regardless of aspect ratio or resolution — must preserve the same visual ratio of:

1. artwork to coloured background,
2. margin widths to the whole format,
3. signature position relative to artwork and product edge.

Identical border *pixel counts* across variants are explicitly **not** a goal;
consistent *proportions* are. When a variant's aspect ratio requires it, the
system must scale and position the artwork rather than centrally crop a flattened
master.

## Decision

Replace the prepare-time `crop(master)` step with a **proportional `compose(layers)`
step**. One artwork master (painting only, no border) + one background colour +
one SVG signature are placed onto an exact-pixel canvas per Prodigi profile,
driven by a single product-level layout definition that resolves to concrete
pixels per profile.

**Prodigi still receives flattened, exact-pixel JPG/PNG derivatives.** It never
sees the layers. This is the key containment: only the *generation* of the
derivative changes; the fulfilment contract is untouched.

### Why this is contained to the prepare step

| Surface | Change |
|---|---|
| `scripts/lib/prepare-derivatives.ts` `generateDerivative` | **Rewritten** — crop → compose |
| `src/lib/print-assets-prepare.ts` | Config type reshaped; crop guards → layout guards; manifest gains a `layout` block |
| `config/print-assets/{productId}.json` | Reshaped (simpler: one `layout`, not N crops) |
| `scripts/print-assets-prepare.ts` | Resolve layout once per product; loop profiles composing at each canvas |
| R2 keys, immutable storage, `publish_print_asset_revision` RPC, checkout snapshot (`order_items.variant`), signed route, queue consumer, fail-closed paths, admin readiness, `src/server/prodigi/mapper.ts` | **Untouched** |

No new dependency: Sharp already creates solid canvases (`sharp({create:…})`),
rasterises SVG, and composites (`composite`). All already used elsewhere; Sharp
is already a pipeline dependency (kept out of `src/lib/` because its native
binding is incompatible with the Workers runtime — this rewrite stays in
`scripts/lib/`).

## Layout model

### Canvas

The derivative canvas is the **exact Prodigi target `W × H` pixels** for the
profile (e.g. `3600 × 4800`). This is non-negotiable: `assertSnapshotDimensions`
in `src/server/prodigi/mapper.ts` rejects a derivative whose decoded dimensions
differ from `printAreaPx`, and the publish RPC dimension-checks the assignment.
The canvas is filled with the configured `background` colour (flat RGB).

The canvas stays fixed-pixel; the **border thickness becomes proportional** and
therefore varies in pixels across sizes — exactly what the operator asked for.
Percentages define the layout; prepare resolves them to pixels per profile and
records the resolution in the manifest. Proportional composition and
byte-deterministic output are not in conflict.

### Regions (top → bottom)

```text
┌─────────────────────────────────────┐  ▲
│         top margin (mt)             │  │ mt = topMargin · H
│   ┌───────────────────────────┐     │  │
│   │                           │     │  │ artwork box (contain-fit)
│   │         ARTWORK           │     │  │ height = min(derived, artworkMaxHeight · H)
│   │                           │     │  │
│   └───────────────────────────┘     │  │
│           gap (g)                   │  │ g = gapAboveSignature · H
│   ┌───────  SIGNATURE.svg ──────┐   │  │ signature zone = signatureZoneHeight · H
│         bottom margin (mb)          │  │ mb = bottomMargin · H
└─────────────────────────────────────┘  ▼
│← mx →                      ← mx →│
      mx = sideMargin · min(W, H)
```

Side margins are a fraction of the **short side** `S = min(W, H)` so they stay
visually consistent across portrait/landscape mixes (all current formats are
portrait, so this equals a fraction of `W` today; the short-side basis is the
robust generalisation). Vertical regions are fractions of `H`.

### Resolution math (per profile, deterministic, round-half-up)

```text
S  = min(W, H)
mx = round(sideMargin · S)
mt = round(topMargin · H)
mb = round(bottomMargin · H)
g  = round(gapAboveSignature · H)
sigZone = round(signatureZoneHeight · H)

availableW        = W − 2·mx
sigZoneTop        = H − mb − sigZone
artworkBoxTop     = mt
artworkBoxDerived = sigZoneTop − g − artworkBoxTop        // vertical room left for artwork
artworkBoxH       = min(artworkBoxDerived, round(artworkMaxHeight · H))   // ceiling if set
artworkBoxW       = min(round(artworkMaxWidth · W), availableW)           // ceiling if set
```

The artwork is **contain-fit** into `(artworkBoxW, artworkBoxH)`:

```text
scale = min(artworkBoxW / sw, artworkBoxH / sh)           // sw,sh = artwork source pixels
outW  = round(sw · scale)
outH  = round(sh · scale)
artworkX = mx + round((availableW − outW) / 2)             // centred in the available width
artworkY = artworkBoxTop + round((artworkBoxH − outH) / 2) // centred in the artwork box
```

`artworkMaxWidth` / `artworkMaxHeight` are **ceilings** (optional). With both
absent the artwork fills the full space the margins leave; with them set the
operator can leave extra breathing room without fiddling with margins. This is
the only knob besides the margins themselves.

### Signature

`signature.svg` is rasterised by Sharp and **contain-fit into the signature
zone** (`sigZone` tall, `availableW` wide), centred horizontally, placed at
`sigZoneTop`. The SVG is the single source of the mark — never cut from a JPG
(consistent with the operator's "render from SVG/font" rule).

`signature` is optional in config. If absent, the signature zone collapses
(`sigZone = 0`, `g = 0`) and the artwork box expands into the freed vertical
space — so a design without a separate signature still composes correctly.

## Data shapes

### `config/print-assets/{productId}.json` (new schema)

```jsonc
{
  "product": "fap01",
  "artwork": "design/print-assets/fap01/artwork-master.png",   // painting only, no border
  "background": "#E8E0D7",
  "format": "jpg",                                             // product-level; jpg | png
  "layout": {
    "sideMargin":          0.06,   // fraction of short side
    "topMargin":           0.06,   // fraction of H
    "bottomMargin":        0.05,   // fraction of H
    "gapAboveSignature":   0.022,  // fraction of H
    "signatureZoneHeight": 0.028,  // fraction of H
    "artworkMaxWidth":     0.85,   // optional ceiling, fraction of W
    "artworkMaxHeight":    0.76    // optional ceiling, fraction of H
  },
  "signature": {                                              // optional
    "svg": "design/print-assets/fap01/signature.svg"
  },
  "gallery": {                                                // unchanged shape
    "hero": { "sourceProfile": "8400x12000", "uploadStem": "fap-01" }
  }
}
```

Net change vs. today: the `profiles` map (one explicit crop per profileKey)
**disappears**. One `layout` adapts to every profile automatically — a
*reduction* in config surface and in the per-artwork authoring burden. `format`
moves from per-profile to product-level (mixed formats across one design's
profiles has never been needed).

### `PrepareConfig` type (`src/lib/print-assets-prepare.ts`)

```ts
export interface PrintLayout {
  sideMargin: number;
  topMargin: number;
  bottomMargin: number;
  gapAboveSignature: number;
  signatureZoneHeight: number;
  artworkMaxWidth?: number;   // ceiling
  artworkMaxHeight?: number;  // ceiling
}

export interface SignatureConfig {
  svg: string;                // path relative to repo root, under design/
}

export interface PrepareConfig {
  product: string;
  artwork: string;            // path to artwork-only master, under design/
  background: string;         // hex colour, e.g. "#E8E0D7"
  format: DerivativeFormat;   // product-level
  layout: PrintLayout;
  signature?: SignatureConfig;
  gallery?: Record<string, GallerySlotConfig>;   // unchanged
}
```

### Manifest extension (as shipped — schema v2)

`PrepareManifest` gains a `layout` snapshot for reproducibility/audit (mirrors
the operator's "save the layout result as a manifest" requirement), plus a
tracked-config provenance hash and an explicit schema discriminator added by
the later manifest-hardening pass. As shipped, the shape is flatter than
originally sketched here: `rendererVersion`, `background`, and `configSha256`
are top-level `PrepareManifest` fields (not nested inside `layout`), and
`layout` itself is exactly the configured `PrintLayout` fractions — nothing
else. `artwork` and `signature` are each a small object carrying that file's
repo-relative `path` alongside its hash (and, for `artwork`, its decoded
dimensions) — the `upload`/`verify` preflight needs `path` to confirm the
tracked config and the manifest still agree on which files were used:

```ts
export const COMPOSE_RENDERER_VERSION = '2.1.0'; // bump on any Sharp-logic change

export interface PrepareManifest {
  schemaVersion: 2;                  // the JSON shape — bump only when the shape itself changes
  product: string;
  revision: string;
  rendererVersion: string;           // the compose pipeline's output-byte logic — independent of schemaVersion
  configSha256: string;              // raw bytes of config/print-assets/{productId}.json
  background: string;                // hex, as configured
  layout: PrintLayout;               // the fractions, as configured — no wrapper object
  artwork: { path: string; sha256: string; width: number; height: number };
  signature: { path: string; sha256: string } | null; // null when no signature configured
  derivatives: ManifestDerivative[]; // each gains resolved artworkBoxPx + signatureBoxPx (see below)
  assignments: ManifestAssignment[]; // unchanged
}
```

`schemaVersion` and `rendererVersion` answer different questions and must not
be conflated: `schemaVersion` (currently `2`) is the JSON shape a parser
checks structurally; `rendererVersion` (currently `2.1.0`) is the Sharp
compose pipeline's output-byte logic — it bumped from `2.0.0` when the
signature-rasterisation density bound changed (a byte-affecting fix, no
shape change at all). `upload`/`verify` pin to the current `rendererVersion`
exactly (a stale renderer throws with re-prepare guidance); `publish` alone
also accepts a validated pre-v2 **legacy** manifest for rollback, with no
`schemaVersion` or `rendererVersion` requirement — see
`docs/print-asset-runbook.md` § Manifest compatibility and § Recovery
procedures.

Each `ManifestDerivative` records its resolved placement so a derivative is
self-describing and re-generatable from the manifest + the two layer files:

```ts
// on ManifestDerivative
artworkBoxPx:   { x: number; y: number; width: number; height: number };  // placement on this canvas
signatureBoxPx: { x: number; y: number; width: number; height: number } | null;
```

Schema v2 stores each derivative fact exactly once and derives the rest:
`width` / `height` / `format` / `sha256` / `byteSize` are stored;
`profileKey`, `contentType`, and `r2Key` are never stored redundantly — every
consumer recomputes them on demand (`profileKeyFromPx`, `contentTypeForFormat`,
`derivativeR2Key` in `src/lib/print-assets-prepare.ts`). This is a further
divergence from the sketch above (which assumed `r2Key` / `contentType`
remained stored fields): only the **legacy** (pre-v2) manifest shape still
carries them stored, which is exactly why publish's legacy projection
recomputes and cross-checks each one against the legacy manifest's own
dimensions/format/hash before trusting it.

## Contracts preserved (explicitly unchanged)

These must not move. The spec's containment guarantee rests on them:

- **R2 key shape** `prints/{productId}/{revision}/{w}x{h}-{sha256}.{ext}`
  (`buildR2Key`) and the immutability rules.
- **Atomic publish RPC** `publish_print_asset_revision(product_id, revision,
  assignments_json)` — verifies every active variant maps to a `ready` asset
  whose dimensions equal the variant's `printAreaPx`. Composition changes *what
  pixels are in* the derivative, not its dimensions, so this check still passes.
- **Checkout snapshot** (`order_items.variant` carries `assetId`, `assetKey`,
  `assetSha256`, `assetContentType`, `assetWidthPx`, `assetHeightPx`).
- **Signed Worker proxy** (`/api/print-assets/[id]` signs `assetId:exp`,
  resolves to the immutable `r2_key`).
- **Mapper** (`src/server/prodigi/mapper.ts`): `sizing: 'fillPrintArea'`,
  `assertSnapshotDimensions`, `assets: [{ printArea: 'default', url }]`.
- **Fail-closed fulfilment** — missing assignment/row/object →
  `failed_action_required` / retryable; never a public-image fallback.

## Validation rules (pure, in `src/lib/print-assets-prepare.ts`)

All checked **before** Sharp runs, returning every error at once (matches the
existing `validateProfileCoverage` / `validateManifest` pattern):

1. **Runtime config shape**, layout fractions in `[0, 1]`, and a well-formed
   six-digit hex `background`.
2. **Vertical fit per profile** — for every active profile, the resolved
   vertical stack must not overflow:
   `mt + artworkBoxDerived + g + sigZone + mb ≤ H` (equivalently
   `artworkBoxDerived ≥ someMin`, e.g. > 0; a tighter minimum can be set to
   reject degenerate layouts). Replaces today's `validateProfileCoverage`.
3. **No artwork upscaling** — for every profile, `scale ≤ 1.0`
   (`min(artworkBoxW/sw, artworkBoxH/sh) ≤ 1.0`); i.e. the artwork source is at
   least as large as the box in the limiting dimension. Replaces today's
   `validateNoEnlargement` (which checked a crop region ≥ target).
4. **Signature SVG exists and parses** when configured.
5. **Artwork master decodes** and has non-zero dimensions.
6. **Manifest self-consistency** — each derivative's `artworkBoxPx` recomputed
   from the recorded `layout` + the derivative's `width`/`height` matches the
   recorded placement (proves determinism). Extends `validateManifest`.
7. **Non-degenerate placement** — artwork and signature boxes have positive
   dimensions and remain within every target canvas; assignments reference an
   existing, unique derivative profile.

### Loosened restriction (deliberate, beneficial)

Today `generateDerivative` **fails** a PNG source with an alpha channel. With
composition onto an explicit background canvas, an RGBA artwork master is now
**acceptable**: alpha composites naturally onto the configured `background`, and
the output derivative is still flattened (no transparency reaches Prodigi). The
alpha rejection is dropped for the artwork layer; the output-derivative
"no transparency to Prodigi" guarantee is preserved by compositing onto the
opaque background.

## Determinism and reproducibility

- Fixed JPEG encoding (quality 92, `4:4:4`, mozjpeg) and PNG settings carried
  over from the current `generateDerivative` — no encoder jitter.
- Sharp colour-manages the artwork into sRGB before composition. The final
  derivative embeds an sRGB ICC profile via `.withMetadata()`, so the artwork
  and configured RGB background share one declared output colour space and the
  approved colour intent is not left profile-ambiguous for Prodigi.
- Manifest records `rendererVersion`, both layer hashes, the configured
  fractions, and each derivative's resolved pixel boxes. Same two layer files +
  same `layout` + same `rendererVersion` → byte-identical derivatives → the
  existing verify-by-full-SHA-256 and `refuseOverwrite` guarantees hold
  unchanged.

## Operational impact

- **New designs:** author `config/print-assets/{id}.json` in the new shape,
  drop an artwork-only master + `signature.svg` under `design/print-assets/{id}/`,
  run the unchanged `prepare → upload → verify → publish` command sequence.
- **Existing published designs** (`fap01`/`fap02`/`fap03`): keep working until
  revised. A revision under the new pipeline requires re-sourcing each design's
  artwork without its baked border (operator-confirmed available) + a
  `signature.svg`; the atomic publish RPC then swaps assignments with no
  downtime and no migration. Historical orders remain pinned to their
  snapshotted assets.
- The operator review step (`proof-{w}x{h}.jpg` contact sheets) is retained —
  now rendering the *composed* result, so visual sign-off covers artwork
  placement, background, and signature in one view.

## Non-goals

- **Admin upload / slider UI.** Scripts remain the write path (Phase 5 scoped
  this out; volume does not justify it).
- **`focalPoint` / `opticalOffset` heuristic and position sliders.** Contain +
  centre solves the border-cropping defect. Optical tuning is a later knob; the
  door is left open via an optional `layout.offset?` field if needed, not built
  into v1.
- **A runtime layout engine / service.** This is a prepare-time function, not a
  system. Prodigi never sees layers.
- **Re-running composition at request time.** Derivatives are pre-generated,
  immutable, and content-addressed — composition happens once per revision.
- **Changing the R2 key shape, publish RPC, checkout snapshot, signed route, or
  any fulfilment-path code.**
- **Per-profile crops or per-profile format.** One layout, one format, per
  product.

## Deferred to the implementation plan (next step)

- File-by-file change sequence, test additions/rewrites for the pure layout
  math (box resolution, contain scale, vertical-fit, no-upscale, manifest
  self-consistency), and the `fap01` re-prepare as the proof revision.
- Whether to land the new shape alongside the old (e.g. a `compose` vs `crop`
  discriminator) during transition, or cut over cleanly given no published
  design blocks it.
- `rendererVersion` initial value and bump policy. _(Resolved: shipped at
  `2.0.0`; bump on any Sharp-logic change that can affect output bytes. First
  bump was `2.0.0` → `2.1.0` for the bounded signature-rasterisation density
  fix — see `COMPOSE_RENDERER_VERSION` in `src/lib/print-assets-prepare.ts`.)_
