# Spec B — Collection: controlled-feature-rhythm grid + reveals

**Status:** validated design (brainstormed 2026-07-07), not yet implemented.
**Part of:** 2026 Storefront Upgrade (see `docs/plans/2026-storefront-upgrade.md` index). Build order **A → C → B → D**; B consumes Spec A's `.reveal` + `.edge-fade-x` and preserves the `view-transition-name`s Spec C adds to tiles.
**Primary success criterion:** conversion — specifically **collection-page bounce** and **browse→PDP** (view_item_list → select_item).

## The decision that governs this spec

A full irregular "bento" grid is a **conversion risk**: it lowers product density and breaks the equal-tile scan-and-compare rhythm that drives browse conversion. The chosen level is **controlled feature rhythm** — a mostly-uniform grid with a deterministic, sparse set of larger "feature" tiles — which delivers the modern look while protecting density and consistent info placement. No editorial/artist-spotlight cells are interleaved into the shopping grid (a spotlight, if ever wanted, is a band before/after the grid, like the homepage editorial section).

## Hard constraints (inherited)

- No `tokens.css` changes. Build stays `next build --webpack`. Mobile-first. `prefers-reduced-motion` respected (via Spec A).
- Product images stay native `<img>` with `srcSet()` from `lib/images.ts`.

## Grounding (current state)

- `Gallery.tsx` (client) renders `.gallery[data-count]` — a uniform grid (`sizes="(min-width:1101px) 25vw, (min-width:561px) 33vw, 50vw"` ⇒ 4/3/2 columns) of `ProductTile`s, plus `Lightbox` (quick-view) and `SelectionBar`. It emits `view_item_list` and `select_item` analytics.
- `ProductTile.tsx` (client) is **conversion-dense**: image + hover-alt + multi-image badge, veil, sold-tag, selection check, a distinct add-to-cart button (`tile-add`, with the mixed-cart guard), and `tile-meta` (name + price). A crawlable `Link` to the PDP sits underneath.
- `CollectionScreen.tsx` (server) renders the shop-head (eyebrow/title/lead + horizontal family switcher `.shop-switch` + `StatusFilter`), a hint, then `<Gallery>`.

**Therefore B is a layout-only change.** It reuses `Gallery`'s wiring and `ProductTile`'s markup/logic, adding only a size modifier. It must not touch the add-to-cart / lightbox / analytics paths.

## Deliverable

1. A `feature` prop on `ProductTile` that applies a `.tile--feature` class and a larger `sizes` hint.
2. A bento variant of `.gallery` (CSS Grid `dense` packing) where feature tiles span 2×.
3. Spec A `.reveal` (staggered) on tiles; Spec A `.edge-fade-x` on the family switcher.
4. A `bento` boolean prop on `Gallery`/`CollectionScreen` for staged rollout.

---

## §1 · Feature rhythm (deterministic)

Feature tiles are chosen by a **deterministic, SSR-stable rule** on the rendered list index — never random:
- The **first** tile of the category spans **2×2** (heroes the lead piece).
- Thereafter a **fixed cadence** (e.g. every 7th tile) spans **2×1**.

The cadence number is tunable; the rule is pure `index`-based so server and client agree. Filtering (all/available/sold) re-flows which indices are featured — acceptable, since it stays deterministic per current view.

## §2 · Grid CSS

`.gallery--bento` uses the existing column counts with `grid-auto-flow: dense` so spanned tiles leave no holes. Feature tiles get `grid-column: span 2` (and `grid-row: span 2` for the 2×2 lead) via `.tile--feature`.

**Responsive rule (mobile-first):**
- Mobile (2-col): the **lead** tile spans full width (both columns) as a deliberate accent; **cadence** feature tiles stay 1× to preserve two-up density.
- ≥ md: feature tiles span 2× as above.

## §3 · Image sizing

Feature tiles render larger, so their `sizes` hint must match (e.g. feature `50vw` at xl vs normal `25vw`) or the browser serves an under-resolution image. `srcSet()` already provides the widths; only `sizes` changes, driven by the `feature` prop. This is the one correctness detail that keeps large tiles sharp.

## §4 · Motion

- `.reveal` on each tile with a small `--reveal-delay` stagger (by column or index) for a scroll-entry cascade. The from-state-inside-`@supports` rule from Spec A guarantees **no CLS** even with lazy-loaded images (reserve aspect-ratio on the tile).
- `.edge-fade-x` on `.shop-switch` (the horizontal family switcher) to signal overflow — a small, safe modern touch.
- All motion collapses to static under `prefers-reduced-motion` via Spec A's hardened block.

## §5 · Staged rollout

`Gallery` gains a `bento` prop (default **off**). `CollectionScreen` enables it for **one pilot category** first. Measure bounce / scroll-depth / browse→PDP against the uniform control; if non-regressing (ideally better), flip it on for all of `VISIBLE_CATEGORY_ORDER`. This is a one-line prop flip per stage — no parallel implementations.

## Success metric (lightweight)

- Target: **collection-page bounce** (down or flat) and **browse→PDP rate** (`view_item_list` → `select_item`, both already emitted) on the pilot category vs. the uniform control.
- Guardrail: add-to-cart rate from the collection page must not regress (feature tiles keep the add button identical).
- Instrumentation: reuse the existing `view_item_list`/`select_item`; optional scroll-depth via the `site_engagement`/`engagement_type` contract. **Event wiring deferred to the impl plan.**

## Verification

Playwright/unit assertions:
1. Feature tiles carry `grid-column: span 2` and the correct larger `sizes`; the deterministic pattern matches the rule for a known product count.
2. **Every** tile (feature and normal) still renders name, price, and an enabled add-to-cart button.
3. Under `prefers-reduced-motion: reduce`, all tiles are visible (`opacity: 1`) — reuses Spec A's consumer check.

## Risks

- **Density loss on mobile.** Mitigation: cadence features stay 1× on mobile; only the lead tile goes full-width.
- **Feature tile served a small image.** Mitigation: `sizes` bumped via the `feature` prop (§3).
- **Reveal + lazy-load CLS.** Mitigation: Spec A from-state gate + reserved aspect-ratio.
- **Bento still regresses browse conversion on the pilot.** Mitigation: the `bento` prop lets us keep it to one category and revert with a one-line flip before any wider rollout.

## Out of scope for Spec B

- Editorial/artist-spotlight cells inside the grid (excluded by the chosen level).
- The prints collection page (`/fine-art-prints`) — evaluate separately after the pilot.
- Any change to `ProductTile`'s cart/lightbox/analytics behavior.
