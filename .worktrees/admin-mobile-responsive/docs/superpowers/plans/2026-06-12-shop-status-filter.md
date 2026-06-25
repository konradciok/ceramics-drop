# Shop Status Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 3-way sold/available status filter (Wszystkie · Dostępne · Sprzedane) to the shop hub (`/sklep`) and every collection page, so buyers can hide already-sold pieces.

**Architecture:** A pure `filterByStatus` helper holds the logic; a persisted Zustand store (`acc_filter_v1`) holds the active view and is shared by both surfaces; a `StatusFilter` segmented control writes to it; `GroupedGallery` and `Gallery` subscribe and render the filtered subset. Filtering is instant and client-side; the persisted choice is deferred until after hydration (a `useMounted` gate) so SSR and first client render stay identical (default `all`).

**Tech Stack:** Next.js 16 (App Router, client components), Zustand + `persist`, next-intl, Vitest, plain CSS (tokens in `src/styles/tokens.css`).

**Spec:** `docs/superpowers/specs/2026-06-12-shop-status-filter-design.md`

---

## File Structure

**Create**
- `src/lib/status-filter.ts` — `StatusFilter` type, `STATUS_FILTERS`, pure `filterByStatus(products, status)`.
- `src/lib/status-filter.test.ts` — unit tests for `filterByStatus`.
- `src/store/filter.ts` — Zustand persisted store (`useFilter`).
- `src/store/filter.test.ts` — store default + update tests.
- `src/lib/use-mounted.ts` — `useMounted()` hydration-gate hook.
- `src/components/shop/StatusFilter.tsx` — the segmented control (client).

**Modify**
- `messages/pl.json`, `messages/en.json`, `messages/es.json` — new `filter` block.
- `src/styles/site.css` — `.status-filter` control, `.has-filter` row layout, `.shop-empty`.
- `src/components/shop/GroupedGallery.tsx` — filter visible items, hide empty sections + nav pills, empty view.
- `src/components/shop/AllPiecesScreen.tsx` — place `<StatusFilter/>` in the sticky nav row.
- `src/components/shop/Gallery.tsx` — filter visible items, empty view.
- `src/components/shop/CollectionScreen.tsx` — place `<StatusFilter/>` in the switcher row.

**Testing note:** This repo's Vitest environment is `node` with no jsdom (see `vitest.config.ts`), and there are no React component tests in the codebase. TDD therefore applies to the pure helper (Task 1) and the store (Task 2). The UI wiring tasks are verified via `npm run lint`, `npm run build`, and a manual preview pass (Task 9) — do not fabricate component render tests that don't fit the harness.

---

## Task 1: Pure status-filter helper

**Files:**
- Create: `src/lib/status-filter.ts`
- Test: `src/lib/status-filter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/status-filter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { filterByStatus, STATUS_FILTERS } from './status-filter';
import type { Product } from '@/lib/types';

const mk = (id: string, sold: boolean): Product => ({
  id,
  category: 'kubki',
  num: '01',
  image: `/uploads/${id}.webp`,
  price: 95,
  measure: '10 cm',
  sold,
  noteIndex: 0,
});

const products = [mk('k01', false), mk('k02', true), mk('k03', false)];

describe('filterByStatus', () => {
  it('all → returns every product unchanged', () => {
    expect(filterByStatus(products, 'all')).toEqual(products);
  });

  it('available → only unsold pieces', () => {
    expect(filterByStatus(products, 'available').map((p) => p.id)).toEqual(['k01', 'k03']);
  });

  it('sold → only sold pieces', () => {
    expect(filterByStatus(products, 'sold').map((p) => p.id)).toEqual(['k02']);
  });

  it('available → empty when everything is sold', () => {
    expect(filterByStatus([mk('k01', true), mk('k02', true)], 'available')).toEqual([]);
  });

  it('sold → empty when nothing is sold', () => {
    expect(filterByStatus([mk('k01', false)], 'sold')).toEqual([]);
  });

  it('STATUS_FILTERS lists the three views in control order', () => {
    expect(STATUS_FILTERS).toEqual(['all', 'available', 'sold']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/status-filter.test.ts`
Expected: FAIL — cannot resolve `./status-filter` / `filterByStatus is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/status-filter.ts`:

```ts
import type { Product } from '@/lib/types';

/** The three shop views: everything, only purchasable, only sold. */
export type StatusFilter = 'all' | 'available' | 'sold';

/** Render order of the segmented control. */
export const STATUS_FILTERS: StatusFilter[] = ['all', 'available', 'sold'];

/**
 * Narrow a product list to the active status view. Pure (no store / no React),
 * so it is unit-testable and shared by the hub (GroupedGallery) and collection
 * (Gallery) surfaces. Order is preserved — `available` is the same subset/order
 * the lightbox already steps across, so filtering never reorders tiles.
 */
export function filterByStatus(products: Product[], status: StatusFilter): Product[] {
  switch (status) {
    case 'available':
      return products.filter((p) => !p.sold);
    case 'sold':
      return products.filter((p) => p.sold);
    case 'all':
    default:
      return products;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/status-filter.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/status-filter.ts src/lib/status-filter.test.ts
git commit -m "feat(shop): pure filterByStatus helper for sold/available views"
```

---

## Task 2: Persisted filter store

**Files:**
- Create: `src/store/filter.ts`
- Test: `src/store/filter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/store/filter.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useFilter } from './filter';

describe('useFilter store', () => {
  beforeEach(() => {
    useFilter.setState({ status: 'all' });
  });

  it('defaults to "all"', () => {
    expect(useFilter.getState().status).toBe('all');
  });

  it('setStatus updates the active view', () => {
    useFilter.getState().setStatus('available');
    expect(useFilter.getState().status).toBe('available');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/store/filter.test.ts`
Expected: FAIL — cannot resolve `./filter`.

- [ ] **Step 3: Write minimal implementation**

Create `src/store/filter.ts` (mirrors `src/store/cart.ts`):

```ts
/* ============================================================
   Shop status filter store (Zustand + localStorage)
   ------------------------------------------------------------
   Holds the active shop view (all | available | sold). Persisted
   under `acc_filter_v1` so the choice follows the visitor across
   the /sklep hub and the per-category collection pages and
   survives reload. Shared, client-only state — the actual
   filtering lives in src/lib/status-filter.ts.
   ============================================================ */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { StatusFilter } from '@/lib/status-filter';

interface FilterState {
  status: StatusFilter;
  setStatus: (status: StatusFilter) => void;
}

export const useFilter = create<FilterState>()(
  persist(
    (set) => ({
      status: 'all',
      setStatus: (status) => set({ status }),
    }),
    { name: 'acc_filter_v1' },
  ),
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/store/filter.test.ts`
Expected: PASS (2 tests). A persist "unable to update item" warning in node is harmless (no localStorage in the node test env).

- [ ] **Step 5: Commit**

```bash
git add src/store/filter.ts src/store/filter.test.ts
git commit -m "feat(shop): persisted status-filter store (acc_filter_v1)"
```

---

## Task 3: Hydration-gate hook

**Files:**
- Create: `src/lib/use-mounted.ts`

No unit test — the hook is a 2-line `useState`/`useEffect` and the node test env has no React renderer. It is covered behaviorally by the preview pass (Task 9).

- [ ] **Step 1: Write the hook**

Create `src/lib/use-mounted.ts`:

```ts
'use client';

import { useEffect, useState } from 'react';

/**
 * False during SSR and the first client render, true after mount. Used to defer
 * persisted-store (localStorage) values until after hydration so the server HTML
 * and the first client render match. The status filter (acc_filter_v1) uses this
 * to render the SSR default ("all") first, then apply the saved choice.
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/use-mounted.ts
git commit -m "feat: useMounted hydration-gate hook"
```

---

## Task 4: i18n filter strings

**Files:**
- Modify: `messages/pl.json`, `messages/en.json`, `messages/es.json`

In each file the `"gallery"` block looks like:

```json
  "gallery": {
    "sold": "..."
  },
```

Insert a new `"filter"` block immediately after the closing `},` of the `"gallery"` block (i.e. between `gallery` and whatever follows it).

- [ ] **Step 1: Add the `filter` block to `messages/pl.json`**

```json
  "filter": {
    "label": "Filtruj prace",
    "all": "Wszystkie",
    "available": "Dostępne",
    "sold": "Sprzedane",
    "emptyAvailable": "Wszystkie prace z tej kolekcji znalazły już dom.",
    "emptySold": "Nic jeszcze nie zostało sprzedane."
  },
```

- [ ] **Step 2: Add the `filter` block to `messages/en.json`**

```json
  "filter": {
    "label": "Filter pieces",
    "all": "All",
    "available": "Available",
    "sold": "Sold",
    "emptyAvailable": "Every piece here has already found a home.",
    "emptySold": "Nothing has sold yet."
  },
```

- [ ] **Step 3: Add the `filter` block to `messages/es.json`**

```json
  "filter": {
    "label": "Filtrar piezas",
    "all": "Todas",
    "available": "Disponibles",
    "sold": "Vendidas",
    "emptyAvailable": "Todas las piezas de esta colección ya encontraron casa.",
    "emptySold": "Aún no se ha vendido nada."
  },
```

- [ ] **Step 4: Verify JSON is valid in all three**

Run: `node -e "for (const l of ['pl','en','es']) { const m = require('./messages/'+l+'.json'); if (!m.filter || !m.filter.all) throw new Error('missing filter in '+l); } console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 5: Commit**

```bash
git add messages/pl.json messages/en.json messages/es.json
git commit -m "i18n(shop): status filter labels + empty-state copy"
```

---

## Task 5: StatusFilter segmented control

**Files:**
- Create: `src/components/shop/StatusFilter.tsx`

- [ ] **Step 1: Write the component**

Create `src/components/shop/StatusFilter.tsx`:

```tsx
'use client';

import { useRef, type KeyboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { useFilter } from '@/store/filter';
import { STATUS_FILTERS, type StatusFilter as Status } from '@/lib/status-filter';
import { useMounted } from '@/lib/use-mounted';
import { buildEngagementEvent, pushDataLayer } from '@/lib/analytics';

/**
 * Segmented control (Wszystkie · Dostępne · Sprzedane) that drives the shared
 * filter store. Single-select radiogroup with roving tabindex + arrow-key nav.
 * Until mounted it shows the SSR default ("all") to avoid a hydration mismatch
 * with the persisted choice. Used on /sklep (sticky nav) and collection pages.
 */
export function StatusFilter() {
  const t = useTranslations();
  const mounted = useMounted();
  const stored = useFilter((s) => s.status);
  const setStatus = useFilter((s) => s.setStatus);
  const active: Status = mounted ? stored : 'all';
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const choose = (status: Status) => {
    if (status === active) return;
    setStatus(status);
    // Demand signal: how often visitors narrow the shop. Reuses the single
    // site_engagement event keyed by engagement_type (see docs/analytics-stack.md).
    pushDataLayer(buildEngagementEvent('shop_filter', { filter_status: status }));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    const next = (index + dir + STATUS_FILTERS.length) % STATUS_FILTERS.length;
    choose(STATUS_FILTERS[next]);
    refs.current[next]?.focus();
  };

  return (
    <div className="status-filter" role="radiogroup" aria-label={t('filter.label')}>
      {STATUS_FILTERS.map((status, i) => {
        const on = status === active;
        return (
          <button
            key={status}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            className={on ? 'on' : undefined}
            onClick={() => choose(status)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {t(`filter.${status}`)}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors. (If `buildEngagementEvent`/`pushDataLayer` import paths differ, confirm against `src/lib/analytics.ts` — they are exported there with signature `buildEngagementEvent(engagementType: string, properties?: Record<string, unknown>)`.)

- [ ] **Step 3: Commit**

```bash
git add src/components/shop/StatusFilter.tsx
git commit -m "feat(shop): StatusFilter segmented control (radiogroup)"
```

---

## Task 6: Shop filter styles

**Files:**
- Modify: `src/styles/site.css`

The control must read as a *connected capsule*, visually distinct from the outlined `.shop-switch` category pills. Add these rules right after the `.shop-switch a.active` rule (around line 342).

- [ ] **Step 1: Add the CSS**

Append after `.shop-switch a.active { ... }`:

```css
/* Status filter — connected segmented control (all / available / sold).
   A single pill-shaped capsule with joined segments, distinct from the
   outlined .shop-switch category pills. */
.status-filter {
  display:inline-flex; flex:none; align-self:center;
  border:1px solid var(--c-line); border-radius:var(--r-pill); overflow:hidden;
  background:var(--c-paper);
}
.status-filter button {
  font-family:var(--f-cond); font-size:12px; letter-spacing:.16em; text-transform:uppercase;
  white-space:nowrap; cursor:pointer; color:var(--c-espresso);
  padding:11px 18px; border:0; background:transparent;
  border-left:1px solid var(--c-line-soft); transition:all .25s var(--ease);
}
.status-filter button:first-child { border-left:0; }
.status-filter button:hover { background:var(--c-bone); }
.status-filter button.on { background:var(--c-espresso); color:var(--c-paper); }
.status-filter button:focus-visible { outline:2px solid var(--c-terracotta); outline-offset:-2px; }

/* Rows that host both category pills (left) and the status filter (right).
   Used by /sklep's sticky nav (.shop-nav-track) and the collection switcher
   (.shop-switch-row). Wraps so on a phone the scrolling pill row keeps its full
   width and the filter drops to its own line below. */
.shop-nav-track.has-filter,
.shop-switch-row {
  display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px 16px;
}
.shop-nav-track.has-filter > .shop-switch,
.shop-switch-row > .shop-switch { flex:1 1 auto; min-width:0; }

/* Empty-state message when a filter yields no pieces. */
.shop-empty {
  max-width:var(--max); margin:clamp(40px,6vw,96px) auto; padding:0 var(--gut);
  text-align:center; font-family:var(--f-cond); font-size:15px; letter-spacing:.04em; opacity:.7;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/styles/site.css
git commit -m "style(shop): status filter control, row layout, empty state"
```

---

## Task 7: Wire the filter into the hub (/sklep)

**Files:**
- Modify: `src/components/shop/GroupedGallery.tsx`
- Modify: `src/components/shop/AllPiecesScreen.tsx`

### 7a — GroupedGallery

- [ ] **Step 1: Add imports**

In `src/components/shop/GroupedGallery.tsx`, add to the existing imports:

```tsx
import { useFilter } from '@/store/filter';
import { filterByStatus } from '@/lib/status-filter';
import { useMounted } from '@/lib/use-mounted';
```

- [ ] **Step 2: Compute the active status and visible set**

Immediately after `const available = useMemo(() => products.filter((p) => !p.sold), [products]);` (line 31), add:

```tsx
  // Active filter view, deferred until after hydration (SSR renders "all").
  const mounted = useMounted();
  const storedStatus = useFilter((s) => s.status);
  const status = mounted ? storedStatus : 'all';
  // Tiles to render. NOTE: `available` (lightbox / analytics index space) stays
  // the full unsold set on purpose — sold tiles are never clickable, so the
  // clickable set is identical whether the view is "all" or "available".
  const visible = useMemo(() => filterByStatus(products, status), [products, status]);
```

- [ ] **Step 3: Group from `visible` instead of `products`**

Replace the `groups` memo body so it iterates `visible` and depends on `visible`:

```tsx
  const groups = useMemo(() => {
    const byCat = new Map<CategorySlug, Product[]>();
    for (const p of visible) {
      const list = byCat.get(p.category) ?? [];
      list.push(p);
      byCat.set(p.category, list);
    }
    return CATEGORY_ORDER
      .map((slug) => ({ slug, items: byCat.get(slug) ?? [] }))
      .filter((g) => g.items.length > 0);
  }, [visible]);
```

- [ ] **Step 4: Hide jump-nav pills for empty categories**

Add this effect right after the `groups` memo (before the scroll-spy effect):

```tsx
  // Keep the sticky #shop-nav honest: hide pills whose category has no visible
  // pieces under the active filter. The nav is server-rendered by
  // AllPiecesScreen; GroupedGallery already owns it for scroll-spy.
  useEffect(() => {
    const visibleSlugs = new Set(groups.map((g) => g.slug));
    document
      .querySelectorAll<HTMLAnchorElement>('#shop-nav a[href^="#"]')
      .forEach((a) => {
        const slug = decodeURIComponent(a.getAttribute('href')!.slice(1));
        a.hidden = !visibleSlugs.has(slug);
      });
  }, [groups]);
```

- [ ] **Step 5: Render the empty state when nothing matches**

Replace the `groups.map(...)` block in the returned JSX (the `<section>` loop) with a guarded version:

```tsx
      {groups.length === 0 ? (
        <p className="shop-empty">
          {status === 'sold' ? t('filter.emptySold') : t('filter.emptyAvailable')}
        </p>
      ) : (
        groups.map(({ slug, items }) => (
          <section key={slug} id={slug} className="gallery-group">
            <h2 className="gallery-group-head">{t(CATEGORIES[slug].nameKey)}</h2>
            <div className="gallery" data-count={items.length}>
              {items.map((p) => (
                <ProductTile key={p.id} product={p} onOpen={openTile} />
              ))}
            </div>
          </section>
        ))
      )}
```

Leave the `<Lightbox products={available} ... />` and `<SelectionBar />` exactly as they are.

### 7b — AllPiecesScreen

- [ ] **Step 6: Import StatusFilter**

In `src/components/shop/AllPiecesScreen.tsx`, add:

```tsx
import { StatusFilter } from './StatusFilter';
```

- [ ] **Step 7: Restructure the sticky nav row to host the filter**

Replace the `<nav id="shop-nav" ...>` block (lines 32–40) with:

```tsx
      <nav id="shop-nav" className="shop-nav-sticky" aria-label={t('nav.sklep')}>
        <div className="shop-nav-track has-filter">
          <div className="shop-switch">
            {CATEGORY_ORDER.map((s) => (
              <a key={s} href={`#${s}`}>
                {t(CATEGORIES[s].nameKey)}
              </a>
            ))}
          </div>
          <StatusFilter />
        </div>
      </nav>
```

(The old markup combined `shop-switch shop-nav-track` on one div; this splits them so the track is the flex row and `.shop-switch` keeps its own horizontal-scroll behavior. Scroll-spy still targets `#shop-nav a`.)

- [ ] **Step 8: Typecheck + build**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 9: Commit**

```bash
git add src/components/shop/GroupedGallery.tsx src/components/shop/AllPiecesScreen.tsx
git commit -m "feat(shop): status filter on /sklep hub (filter, empty nav pills, empty view)"
```

---

## Task 8: Wire the filter into collection pages

**Files:**
- Modify: `src/components/shop/Gallery.tsx`
- Modify: `src/components/shop/CollectionScreen.tsx`

### 8a — Gallery

- [ ] **Step 1: Add imports**

In `src/components/shop/Gallery.tsx`, add `useTranslations` to the next-intl import and add the filter imports:

```tsx
import { useLocale, useTranslations } from 'next-intl';
import { useFilter } from '@/store/filter';
import { filterByStatus } from '@/lib/status-filter';
import { useMounted } from '@/lib/use-mounted';
```

- [ ] **Step 2: Compute active status + visible set**

After `const available = useMemo(() => products.filter((p) => !p.sold), [products]);` (line 23), add:

```tsx
  const t = useTranslations();
  const mounted = useMounted();
  const storedStatus = useFilter((s) => s.status);
  const status = mounted ? storedStatus : 'all';
  // Rendered tiles. `available` stays the full unsold set (lightbox/analytics
  // index space) — sold tiles are never clickable, so it is unaffected by view.
  const visible = useMemo(() => filterByStatus(products, status), [products, status]);
```

- [ ] **Step 3: Render `visible` with an empty state**

Replace the `<div className="gallery" ...>...</div>` block in the JSX with:

```tsx
      {visible.length === 0 ? (
        <p className="shop-empty">
          {status === 'sold' ? t('filter.emptySold') : t('filter.emptyAvailable')}
        </p>
      ) : (
        <div className="gallery" data-count={visible.length}>
          {visible.map((p) => (
            <ProductTile
              key={p.id}
              product={p}
              onOpen={(prod) => {
                triggerRef.current = document.activeElement as HTMLElement;
                const index = available.findIndex((a) => a.id === prod.id);
                pushDataLayer(
                  buildSelectItemEvent(prod, {
                    index,
                    itemListId: listId,
                    itemListName: listName,
                    currency: analyticsCurrency,
                    priceOverride: priceOf(prod, locale),
                  }),
                );
                setOpenIndex(index);
              }}
            />
          ))}
        </div>
      )}
```

Leave `<Lightbox products={available} ... />` and `<SelectionBar />` unchanged.

### 8b — CollectionScreen

- [ ] **Step 4: Import StatusFilter**

In `src/components/shop/CollectionScreen.tsx`, add:

```tsx
import { StatusFilter } from './StatusFilter';
```

- [ ] **Step 5: Wrap the switcher row to host the filter**

Replace the `<div className="shop-switch">...</div>` block (lines 35–41) with:

```tsx
          <div className="shop-switch-row">
            <div className="shop-switch">
              {CATEGORY_ORDER.map((s) => (
                <Link key={s} href={`/${s}`} className={s === slug ? 'active' : undefined}>
                  {t(CATEGORIES[s].nameKey)}
                </Link>
              ))}
            </div>
            <StatusFilter />
          </div>
```

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add src/components/shop/Gallery.tsx src/components/shop/CollectionScreen.tsx
git commit -m "feat(shop): status filter on collection pages (filter, empty view)"
```

---

## Task 9: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Unit tests**

Run: `npm run test`
Expected: all pass, including the new `status-filter` and `filter` store tests.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 3: Production build (must use webpack — never Turbopack)**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Preview pass**

Start the dev server (`npm run dev`) and verify on `/sklep`:
- The segmented control sits to the right of the category pills in the sticky bar; stacks below the pills at <561px width.
- `Dostępne` hides all sold tiles instantly; the previously-sold tiles disappear and their empty categories' jump-nav pills disappear too.
- `Sprzedane` shows only sold pieces; categories with no sold pieces (and their pills) are hidden. If nothing is sold, the centered empty message shows.
- `Wszystkie` restores everything.
- Switch to a collection page (e.g. `/kubki`) — the filter choice carried over (it shows the same view). Reload — the choice persists.
- Keyboard: focus a segment, press ←/→ — selection moves and applies.
- Confirm default first paint on a fresh browser (no `acc_filter_v1` in localStorage) is `Wszystkie` (no tiles hidden, no hydration warning in console).

- [ ] **Step 5: Final commit (if any preview fixes were needed)**

```bash
git add -A
git commit -m "chore(shop): status filter verification fixes"
```

---

## Self-Review (completed by plan author)

**Spec coverage:** 3-way control + default all (Tasks 5, 7, 8) ✓; both surfaces via one shared control (Tasks 5/7/8) ✓; session-persisted client filtering (Task 2 store + mounted gate Task 3) ✓; placement option B + segmented style + stacks on mobile (Tasks 6/7/8) ✓; no counts ✓; empty states for grouped + collection + empty nav pills (Tasks 6/7/8) ✓; lightbox unchanged (documented rationale in Tasks 7/8) ✓; a11y radiogroup + arrow keys (Task 5) ✓; `site_engagement` `shop_filter` analytics (Task 5) ✓; i18n keys all 3 locales (Task 4) ✓; unit tests for the pure logic + store (Tasks 1/2) ✓; build stays `--webpack` (Task 9 note) ✓.

**Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output.

**Type consistency:** `StatusFilter`/`filterByStatus`/`STATUS_FILTERS` defined in Task 1 and used identically in Tasks 2/5/7/8; `useFilter` (`status`/`setStatus`) defined in Task 2 and used consistently; `useMounted` defined in Task 3 and used in Tasks 5/7/8; `buildEngagementEvent(type, props)` matches `src/lib/analytics.ts`.

**Open decision deferred to implementer (per spec risk note):** pill-hiding is owned by `GroupedGallery` (the existing client owner of `#shop-nav`), resolved in Task 7 Step 4.
