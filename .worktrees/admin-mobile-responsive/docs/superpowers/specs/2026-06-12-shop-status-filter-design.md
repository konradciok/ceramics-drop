# Shop Status Filter — Design Spec

**Date:** 2026-06-12
**Status:** Approved (brainstorm) — ready for planning
**Surfaces:** `/sklep` hub + all collection pages (`/{category}`)

## Goal

Help buyers shop faster. The catalogue mixes sold and available pieces in one grid; sold tiles ("już znalazła dom") add clutter for someone trying to find what they can actually buy. Give visitors a control to narrow the view to **Available**, while still letting them browse **All** (default, preserves brand charm + SEO) or **Sold**.

## Decisions (from brainstorm)

| Question | Decision |
|---|---|
| Primary goal | Help buyers shop faster (declutter sold) |
| Surfaces | Shop hub **and** collection pages, via one shared control |
| States | 3-way: **All / Available / Sold** (`Wszystkie / Dostępne / Sprzedane`), default **All** |
| Persistence | Instant client-side filtering; choice remembered across session (localStorage), carries hub↔collection, survives reload |
| Placement | Same row as the category pills, pinned right (option B); stacks below on mobile |
| Control style | Connected **segmented control** (distinct from the outlined category pills) |
| Counts | No counts in labels |

## Behavior

- **States & default:** `all` (default) → `available` → `sold`. Default `all` keeps first paint and SEO identical to today.
- **Placement:**
  - `/sklep`: inside the sticky `#shop-nav` row (`.shop-nav-track`), right-aligned next to the category jump-nav pills.
  - Collection pages: inside the category-switcher row in the head, right-aligned.
  - Mobile: the category pills keep their horizontal-scroll row; the filter drops to its own line.
- **Persistence:** Zustand store with `persist`, key `acc_filter_v1`. Same store instance/key across all shop surfaces, so the choice follows the user and survives reload.
- **First paint:** SSR always renders `all`. A returning visitor with a saved non-`all` choice sees a single-frame reflow after hydration as non-matching tiles drop out — tiles disappear, no layout jank. Accepted; not worth a pre-paint inline script.
- **Empty states:**
  - `/sklep` grouped view: a category with zero matches under the active filter hides **both** its `<section>` and its jump-nav pill (nav stays honest). If the entire view is empty (e.g. `Sold` early in a drop), show one centered message.
  - Collection page: if the filtered set is empty, replace the grid with a centered message.
- **Lightbox:** Unchanged in practice. Sold tiles never open the lightbox (they link to the PDP), so the lightbox keeps stepping across the available pieces within the currently visible set. When filter = `sold`, the lightbox is simply unused.

## Architecture

### New files

- **`src/lib/status-filter.ts`** — pure, testable core.
  - `export type StatusFilter = 'all' | 'available' | 'sold'`
  - `export const STATUS_FILTERS: StatusFilter[]`
  - `export function filterByStatus(products: Product[], status: StatusFilter): Product[]`
    - `all` → unchanged; `available` → `!p.sold`; `sold` → `p.sold`
  - No React, no store imports — keeps logic unit-testable and components thin.

- **`src/store/filter.ts`** — Zustand store, mirrors the cart-store pattern (`src/store/cart.ts`).
  - State: `{ status: StatusFilter; setStatus(s: StatusFilter): void }`
  - `persist`, storage key `acc_filter_v1`, default `status: 'all'`.

- **`src/components/shop/StatusFilter.tsx`** — `'use client'` segmented control.
  - Reads `status` / `setStatus` from the store.
  - Renders `role="radiogroup"` (labelled) with three `role="radio"` segments (`aria-checked`), roving `tabindex`, ←/→ arrow navigation.
  - Fires the analytics engagement event on user-initiated change (not on hydration/restore).
  - Labels + aria-label from i18n.

### Modified files

- **`src/components/shop/GroupedGallery.tsx`**
  - Subscribe to the filter store; compute `visible = filterByStatus(products, status)`.
  - Group `visible` by category; render only non-empty sections.
  - Hide jump-nav pills whose category has zero visible items (coordinate with the server-rendered `#shop-nav` — toggle a class / `hidden` on the matching `a` from the client, or render pill visibility from the same visible set).
  - Keep IntersectionObserver scroll-spy working over the visible sections only.
  - Lightbox array = available subset of `visible` (today it is `available`; becomes available-within-visible).
  - If `visible` is empty, render the centered empty message instead of sections.

- **`src/components/shop/Gallery.tsx`**
  - Subscribe to the filter store; `visible = filterByStatus(products, status)`.
  - Render `visible` tiles; lightbox over available subset of `visible`.
  - If `visible` empty, render centered empty message.

- **`src/components/shop/AllPiecesScreen.tsx`**
  - Place `<StatusFilter/>` in the `.shop-nav-track` row (right side). (Dropping a client component into this server component is fine.)

- **`src/components/shop/CollectionScreen.tsx`**
  - Place `<StatusFilter/>` in the category-switcher row (right side).

- **`src/styles/site.css`**
  - `.status-filter` — connected segmented control (pill-shaped container, three joined segments, active = espresso fill / paper text), matching tokens (`--c-espresso`, `--c-paper`, `--c-line`, `--r-pill`, `--f-cond`, uppercase + letter-spacing like `.shop-switch a`).
  - Make `.shop-nav-track` and the collection switcher row flex with `justify-content:space-between`; `.status-filter` is `flex:none`; stacks below the pills on mobile (`<561px`).
  - `.shop-empty` — centered empty-state message styling.

### i18n — `messages/{pl,en,es}.json`

New `filter` block:
- `filter.label` — aria-label (PL "Filtruj prace", EN "Filter pieces", ES "Filtrar piezas")
- `filter.all` / `filter.available` / `filter.sold` — segment labels (PL: Wszystkie / Dostępne / Sprzedane)
- `filter.emptyAvailable` — PL "Wszystkie prace z tej kolekcji znalazły już dom." (+ EN/ES)
- `filter.emptySold` — PL "Nic jeszcze nie zostało sprzedane." (+ EN/ES)

### Analytics

Reuse the existing single `site_engagement` event convention (see `docs/analytics-stack.md`): on user-initiated filter change, fire `engagement_type: 'shop_filter'` with the chosen status as the value. Consent-gated. Not fired on hydration/persisted-state restore (avoids noise).

## Accessibility

- Segmented control is a proper single-select `radiogroup` (labelled, `aria-checked`, roving tabindex, arrow-key nav). Selection is conveyed semantically, not by color alone.
- Empty-state messages are real text in the content flow.

## Testing

- **Unit (vitest):** `src/lib/status-filter.test.ts` — `filterByStatus` returns correct subsets for `all`/`available`/`sold`, including empty-result cases. This is the meaningful logic coverage.
- **Store:** light test — defaults to `all`, updates on `setStatus`.
- **Manual / preview verification:** on `/sklep`, toggling hides/shows tiles + empty categories + nav pills; choice persists to a collection page and across reload; mobile layout stacks. No new E2E spec (suite is checkout-focused) unless requested.

## Out of scope (YAGNI)

- URL / query-param filter state and shareable links (chose session-remembered).
- Counts in labels.
- Any facet beyond sold/available (no price/attribute filtering).

## Risk notes

- **`#shop-nav` is server-rendered**, but pill-hiding under a filter is a client concern. The cleanest approach is to let `GroupedGallery` (already the client owner of the nav for scroll-spy) toggle pill visibility from the visible set, rather than reflowing the server markup. Confirm during planning which side owns pill visibility.
- Keep the build on `next build --webpack` (non-negotiable per AGENTS.md) — no build-system changes here.
