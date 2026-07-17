# Print asset prepare configs

One file per print product: `config/print-assets/{productId}.json`. Consumed by
`scripts/print-assets-prepare.ts` (see
`docs/superpowers/specs/2026-07-16-proportional-print-composition-design.md`
for the resolution math, and `docs/plans/print-asset-pipeline.md` for the
operator prepare→upload→verify→publish sequence).

## Schema

Each config describes one **proportional composition** that adapts to every
Prodigi print-area aspect ratio — no per-profile `crop` map.

| Field        | Meaning                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------- |
| `product`    | Product id (`fap01`, …).                                                                 |
| `artwork`    | Path to the **artwork-only master** (painting, no baked border), under `design/`.        |
| `background` | Hex colour the canvas is flooded with before the artwork + signature are laid down.      |
| `format`     | Product-level output format (`jpg` or `png`).                                            |
| `layout`     | Fractions of the canvas — see below.                                                     |
| `signature?` | Optional SVG signature layer. Omit ⇒ the signature zone collapses (no gap, no zone).     |
| `gallery?`   | Optional storefront gallery slots (`print-assets:gallery`), e.g. `hero.sourceProfile`.   |

### `layout` — fractions, not pixels

One layout composes every variant. Per-variant pixels are derived by
`resolvePlacement` in `src/lib/print-assets-prepare.ts`.

- **`sideMargin`** is a fraction of the **short side** `min(W, H)` — robust
  across portrait/landscape. Applied to both left and right.
- **Vertical regions** (`topMargin`, `bottomMargin`, `gapAboveSignature`,
  `signatureZoneHeight`) are fractions of canvas **height**.
- `gapAboveSignature` and `signatureZoneHeight` are ignored when `signature`
  is absent.
- `artworkMaxWidth` / `artworkMaxHeight` are **optional ceilings** (fraction of
  `W` / `H`) that shrink the artwork box below what the margins leave; omit
  them to let the artwork fill the available box.
- Every fraction must be a finite number in `[0, 1]` (validated before Sharp
  runs).

The vertical stack is `topMargin + artwork box + gap + signatureZone + bottomMargin`; the artwork is contain-fit into its box (no crop, no upscale).

### `signature` — vector, never a JPG cut-out

`signature.svg` is rendered from vector at full canvas resolution per variant.
Absence is meaningful: no `signature` key ⇒ the gap and signature zone are
zeroed and the artwork box grows into that space.

### Source assets live under `design/`

`artwork` and `signature.svg` paths point into `design/print-assets/{id}/`,
which is **gitignored** — the config is authored ahead of the assets; the
prepare step reads them off disk at run time.

## Already-published assets are immutable

A published revision (e.g. `fap01` @ `2026-07-12-r1`) is immutable in R2 + the
`print_fulfilment_assets` rows. **Editing this config does not affect any
published asset** — it only governs the *next* prepare run. Cutting a new
revision requires re-sourcing the artwork (clean master, no baked border) and a
`signature.svg`, then running the unchanged
`print-assets:prepare` → `:upload` → `:verify` → `:publish` sequence.
