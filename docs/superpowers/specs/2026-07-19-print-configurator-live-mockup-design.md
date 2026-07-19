# Print PDP live mockup — configurator-driven hero visualization

Status: Design approved 2026-07-19 (R&D phase — no implementation plan yet).
Benchmark: The Poster Club PDP behaviour (add-on selection swaps the hero
mockup). Related research: `docs/research/the-poster-club/03-pdp-anatomy.md`,
variant/SKU audit in `docs/research/ourshop/2026-07-19-product-mapping.md`.

## Goal

When a buyer changes any axis in `PrintConfigurator` (framed, frame colour,
passe-partout), the hero image on the print PDP updates to a photorealistic
mockup of that configuration — frame with visible wood texture and shadow,
physically accurate passe-partout — exactly the reassurance pattern The Poster
Club uses.

## Context

### How the benchmark actually works

Inspected `theposterclub.com/products/carla-llanos-flowers-on-blue-table`
(product JSON): frame/passe-partout add-ons are **not** Shopify variants and no
variant carries a `featured_image`. The gallery simply contains a handful of
pre-rendered state images (`Frame_Oak`, `Frame_Red_Passepartout`, unframed,
lifestyle) and client JS swaps the hero when an add-on is selected. Nothing is
composed in the browser. This design adopts the same mechanism: pre-rendered
state images + client-side swap.

### Current repo state

- `PrintProductScreen` (server) renders two independent client islands:
  `ProductPageGallery` (dumb `images[]` + dot nav, own `index` state) and
  `PrintConfigurator` (owns `sel` via `useState`). No shared state — the hero
  cannot react to the configurator today.
- The print-asset pipeline (`config/print-assets/*.json` + sharp composition)
  already produces exact Prodigi print-area derivatives per profile, including
  the smaller CFPM (mount) apertures, and `print-assets:gallery` already
  derives storefront WebPs from published fulfilment derivatives.
- Variant space per design: `size × framed × mount × frameColour`, where mount
  exists **only inside a frame** (`!framed && mount` is rejected). TPC's
  "passe-partout alone" state has no equivalent here and is not needed.
- Storefront hero per design: `public/uploads/fap-XX.webp` (+ srcset sizes),
  generated from the `8400x12000` (70×100, 7:10) fulfilment profile.

## Decisions (settled with the operator)

1. **Fidelity: photorealistic** — real wood texture, baked shadow/depth, like
   TPC. Not a flat CSS stylization.
2. **Size axis is ignored** in the mockup (TPC does the same). The three size
   ratios (3:4, 5:7, 7:10) are visually near-identical at hero scale. One
   canonical mockup per visual state, rendered at the 7:10 hero ratio.
3. **Hero = current configuration.** Slide 0 of the gallery always previews
   the selected variant; other slides (room shots, details) stay reachable via
   dots. On any variant change the gallery returns to slide 0.
4. **Approach: pre-rendered mockups produced by the existing pipeline**
   (approach A). Browser-side layered composition (approach B) was rejected:
   CSS passe-partout physically lies (the CFPM aperture crops the sheet, it is
   not a white border around the full sheet), layer alignment is fragile
   across breakpoints, and zoom/lightbox/OG would need the composition
   repeated.

## Visual state model

Seven states per full-axis design (fewer when the design's axes are narrower):

| state key | selection | hero source |
|---|---|---|
| `plain` | `framed=false` | existing `fap-XX.webp` (no new asset) |
| `framed-black` / `framed-white` / `framed-natural` | `framed, !mount` | new mockup WebP |
| `mount-black` / `mount-white` / `mount-natural` | `framed + mount` | new mockup WebP |

A pure function maps selection → state; a second builds the asset path:

- `src/lib/print-mockups.ts` (new):
  - `mockupState(sel: PrintVariantSelection): MockupState` — total over valid
    selections; the 7-row truth table above.
  - `mockupSrc(design: PrintDesign, state: MockupState): string | undefined` —
    `undefined` when `design.mockups` is not set (feature off for that design)
    or for `plain` (caller uses `design.image`).

Pure functions because the repo has no DOM render harness — same pattern as
`printVariantButtonState`.

## Component architecture

New client wrapper (e.g. `PrintPdpPurchase`) rendered by `PrintProductScreen`
in place of the current two siblings. It owns `sel` (the `useState` moves up
from `PrintConfigurator`) and renders:

- `PrintConfigurator` — becomes **controlled**: receives `sel` + `onChange`.
  Everything else (pricing, `printVariantButtonState`, mixed-cart rule,
  analytics add-to-cart event) is unchanged.
- `ProductPageGallery` — stays dumb. The wrapper computes
  `images[0] = mockupSrc(design, mockupState(sel)) ?? design.image` and passes
  the array as today. One new optional prop `syncKey?: string`: when it
  changes, the gallery resets `index` to 0 (single `useEffect`), so a variant
  change is visible even if the buyer was on another slide.

SSR/no-JS: the server renders the default selection (`framed=false`), whose
hero is the existing static image — identical to today's markup.

Hero `alt` is extended with `variantLabel(sel, locale)` for accessibility.

## Assets & pipeline

New pipeline step `npm run print-assets:mockups` (sibling of
`print-assets:gallery`), per design:

- **Inputs:**
  - the published fulfilment derivative of the `8400x12000` FAP profile
    (sheet) for `framed-*` states;
  - the published `7200x10800` CFPM derivative for `mount-*` states — so the
    passe-partout aperture and visible crop are physically identical to what
    Prodigi will produce;
  - **3 shared frame masters** (black / white / natural — see Open items),
    used for every design, forever.
- **Composition (sharp):** sheet (or mount + aperture crop) into the frame
  master, shadow baked, canonical 7:10 canvas.
- **Outputs:** `public/uploads/fap-XX-mock-framed-{colour}.webp` and
  `fap-XX-mock-mount-{colour}.webp` + srcset variants (400/800/1600w),
  committed like existing gallery assets. Max 6 new WebPs (×4 files with
  srcset) per full-axis design.
- The step reads the design's axes from the registry: fap02
  (`frameColours: [black, white]`, `mountAvailable: false`) automatically gets
  only 2 mockups.
- **Availability flag:** `mockups?: true` on `PrintDesign` in
  `src/lib/prints.ts`, set in the same PR that commits the generated files
  (same convention as `gallery`).
- **Revisions:** mockups derive from the published fulfilment revision; a new
  revision requires re-running the mockup step. Add the step to
  `docs/print-asset-runbook.md` as part of the publish procedure.

## UI behaviour

- Any axis click → `sel` changes → slide 0 swaps to the matching mockup and
  the gallery jumps to slide 0.
- After hydration, prefetch the design's remaining mockups (≤6 images) so
  swaps render without flicker. Only when `design.mockups` is set.
- `disabledAsset` / `disabledStructural` do **not** suppress the
  visualization: the hero shows the selected combination; purchasability is
  communicated by the button, as today.

## Fallbacks & edge cases

- Design without `mockups` (today fap02/03/04): behaviour is byte-identical to
  the current PDP — static hero, working configurator. The feature is purely
  additive; worst failure mode is a static hero.
- `plain` state always uses the existing hero, so the default view never
  depends on new assets.
- Designs whose fulfilment assets are not yet published (fap02/fap03 as of
  2026-07-19) cannot get mockups until their pipeline run — the flag ships
  with the generated files, so no dangling references are possible.

## Testing

- **Vitest:** full 7-row truth table for `mockupState()`; `mockupSrc()` path
  convention + `undefined` for flag-less designs and `plain`.
- **Playwright @ci (hermetic):** on the fap01 PDP — select frame → black:
  hero `src` contains `mock-framed-black`; add passe-partout →
  `mock-mount-black`; back to unframed → base hero. Files live in the repo, so
  the spec runs without network.
- **Pipeline:** composition test in the style of the existing prepare/publish
  tests — output dimensions, 7:10 ratio, correct source profile per state
  (FAP for `framed-*`, CFPM for `mount-*`).

## Open items

1. **Frame masters** — the only asset that must be produced by a human, once:
   photorealistic renders/photographs of the Prodigi Classic Frame in black,
   white and natural, either as corner+edge slices (9-slice scaling in sharp)
   or full frames at 7:10. Requirements: alpha channel, resolution sufficient
   for the 1600w hero (≥ ~2000 px on the long edge), consistent light
   direction so the baked shadow matches across colours.
2. Exact wrapper/component naming and whether `PrintConfigurator`'s `useState`
   moves or is wrapped — implementation detail for the plan phase.

## Non-goals / deferred

- Size-reactive or room-scale visualization ("placement anxiety" answer) —
  candidate for a later phase, deliberately out of scope.
- Per-size mockup renders (21 per design) — rejected with decision 2.
- Browser-side layered composition — rejected with decision 4.
- A dedicated `site_engagement` analytics event for mockup interaction —
  optional, not part of this design.
- Any change to pricing, cart tokens, checkout validation, or the Prodigi
  fulfilment path — this feature is presentation-only.
