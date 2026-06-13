# Inspiracje Editorial Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a new trilingual `/inspiracje` page that presents ceramic pieces in curated interior shots — each look labelled with numbered photo markers and a shoppable product legend that reflects live sold state and deep-links to the exact piece.

**Architecture:** A `src/lib/looks.ts` data file holds all editorial content with per-locale strings (mirroring how `products.ts` centralises product data). A `LookBlock` async server component renders each look with an alternating text/photo layout, resolves prices via `getProductById()`, dims sold pieces using `getSoldIds()`, and deep-links each legend entry to the piece's collection-page anchor. The page maps over `LOOKS`, is wired into nav/footer (only when content exists), and is registered in `SITE_PATHS` so it appears in the sitemap and hreflang cluster.

**Tech Stack:** Next.js 16 App Router, next-intl (trilingual: pl default, en, es), TypeScript, plain CSS (custom properties from `tokens.css`), Vitest for unit tests.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/lib/looks.ts` | Create | Data model (per-locale) + `LOOKS` array |
| `src/lib/looks.test.ts` | Create | Validate marker + localization integrity |
| `src/components/shop/ProductTile.tsx` | Edit | Add per-piece DOM `id` anchor (deep-link target) |
| `src/components/editorial/LookBlock.tsx` | Create | Reusable look component (async server, i18n + sold-aware) |
| `src/components/editorial/LookBlock.css` | Create | Component styles (token-driven) |
| `messages/pl.json` | Edit | nav + title + `inspiracje` section |
| `messages/en.json` | Edit | nav + title + `inspiracje` section |
| `messages/es.json` | Edit | nav + title + `inspiracje` section |
| `src/lib/site.ts` | Edit | Add `/inspiracje` to `SITE_PATHS` (sitemap + hreflang) |
| `src/app/[locale]/inspiracje/page.tsx` | Create | Route page, metadata, sold-state fetch |
| `src/components/layout/Header.tsx` | Edit | Add "Inspiracje" nav link (guarded on `LOOKS.length`) |
| `src/components/layout/Footer.tsx` | Edit | Add "Inspiracje" footer link (guarded on `LOOKS.length`) |
| `src/components/layout/MobileMenu.tsx` | No change | Receives `links` prop from Header — no edit needed |

> **MobileMenu note:** It renders whatever `links` array Header passes. Adding the (guarded) entry to `mobileLinks` in Header is sufficient.

> **Design decisions baked into this plan:**
> - **Trilingual content** — `title`, `editorial`, `imageAlt`, and marker `label` are `Localized` (`{ pl; en; es }`). No Polish leaks to EN/ES visitors. All UI chrome ("Shop this look", the look label, empty-state) comes from message keys.
> - **Sold-aware** — the page fetches `getSoldIds()` (same source collection pages use) and dims sold markers + delists their legend price, reusing the existing `gallery.sold` message key.
> - **Deep-linkable** — available legend entries link to `/{category}#piece-{id}`; `ProductTile` gains the matching `id` anchor (Task 2).
> - **Token-driven CSS** — no hardcoded hex; colours come from `--c-*` tokens.
> - **Column swap via `order`** — desktop reverse layout swaps columns with `order` + track-size swap (preserves DOM/tab order), not a `direction:rtl` hack.
> - **No dead CSS** — markers carry no unused hover/transition.

---

## Task 1: Data model

**Files:**
- Create: `src/lib/looks.ts`
- Create: `src/lib/looks.test.ts`

### Why per-locale fields and a `label`

The site is trilingual (CLAUDE.md i18n section): every visitor-facing string must resolve to the active locale. Look content (title, editorial paragraph, image alt) and the legend display name therefore hold one string per locale. The legend `label` exists because `getProductById()` returns `category` (a slug) and `num`, but no ready-made display name — `label` gives Anna full editorial control over what each legend entry is called, in each language.

- [ ] **Step 1: Write the failing test**

Create `src/lib/looks.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { LOOKS, type Localized } from './looks';
import { getProductById } from './products';
import { routing } from '@/i18n/routing';

/** Assert a Localized field has a non-empty string for every configured locale. */
function expectComplete(value: Localized, ctx: string) {
  for (const locale of routing.locales) {
    expect(value?.[locale], `${ctx} missing/empty for locale "${locale}"`).toBeTruthy();
  }
}

describe('LOOKS', () => {
  it('all look ids are unique', () => {
    const ids = LOOKS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every look has at least one marker', () => {
    for (const look of LOOKS) {
      expect(look.markers.length, `look "${look.id}" has no markers`).toBeGreaterThan(0);
    }
  });

  it('every look image is a /uploads webp path', () => {
    for (const look of LOOKS) {
      expect(look.image, `look "${look.id}" image`).toMatch(/^\/uploads\/.+\.webp$/);
    }
  });

  it('look title / editorial / imageAlt are localized for all locales', () => {
    for (const look of LOOKS) {
      expectComplete(look.title, `look "${look.id}" title`);
      expectComplete(look.editorial, `look "${look.id}" editorial`);
      expectComplete(look.imageAlt, `look "${look.id}" imageAlt`);
    }
  });

  it('marker labels are localized for all locales', () => {
    for (const look of LOOKS) {
      for (const marker of look.markers) {
        expectComplete(marker.label, `look "${look.id}" marker ${marker.num} label`);
      }
    }
  });

  it('all marker productIds resolve via getProductById', () => {
    for (const look of LOOKS) {
      for (const marker of look.markers) {
        expect(
          getProductById(marker.productId),
          `productId "${marker.productId}" in look "${look.id}" not found`,
        ).toBeDefined();
      }
    }
  });

  it('all marker coordinates are within [0, 100]', () => {
    for (const look of LOOKS) {
      for (const marker of look.markers) {
        expect(marker.x, `look ${look.id} marker ${marker.num} x`).toBeGreaterThanOrEqual(0);
        expect(marker.x, `look ${look.id} marker ${marker.num} x`).toBeLessThanOrEqual(100);
        expect(marker.y, `look ${look.id} marker ${marker.num} y`).toBeGreaterThanOrEqual(0);
        expect(marker.y, `look ${look.id} marker ${marker.num} y`).toBeLessThanOrEqual(100);
      }
    }
  });

  it('marker nums are exactly 1..N (sequential, no gaps or dupes)', () => {
    for (const look of LOOKS) {
      const nums = look.markers.map((m) => m.num).sort((a, b) => a - b);
      const expected = Array.from({ length: nums.length }, (_, i) => i + 1);
      expect(nums, `look "${look.id}" marker nums must be 1..${nums.length}`).toEqual(expected);
    }
  });
});
```

- [ ] **Step 2: Run the test — expect it to fail with "Cannot find module './looks'"**

```bash
npx vitest run src/lib/looks.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/looks.ts`**

```typescript
import type { Locale } from '@/i18n/routing';

/** A string in every supported locale (pl default, en, es). */
export type Localized = Record<Locale, string>;

export interface LookMarker {
  /** Number shown on the photo and in the legend (1..N, sequential). */
  num: number;
  /** Product id from products.ts, e.g. 'k04'. Validated by looks.test.ts. */
  productId: string;
  /** Display name for the legend, per locale, e.g. { pl: 'Kubek', en: 'Mug', es: 'Taza' }. */
  label: Localized;
  /** Horizontal position on the photo, % from left edge (of the rendered 4:3 frame). */
  x: number;
  /** Vertical position on the photo, % from top edge (of the rendered 4:3 frame). */
  y: number;
}

export interface Look {
  /** URL-safe slug, e.g. 'slow-morning'. Unique across LOOKS. */
  id: string;
  /** Look title, per locale. Shown in the text column. */
  title: Localized;
  /** One atmospheric paragraph, per locale. Plain text. */
  editorial: Localized;
  /** Path in /public, e.g. '/uploads/look-01.webp'. Run npm run optimize-images first. */
  image: string;
  /** Alt text for the photo, per locale. */
  imageAlt: Localized;
  markers: LookMarker[];
}

/**
 * Editorial looks — the "Inspiracje" page data.
 *
 * Add entries here when Anna shoots a new interior look:
 *  1. Shoot / export the photo at a 4:3 aspect ratio (the page renders it in a
 *     fixed 4:3 frame with object-fit:cover; marker x/y are % of THAT frame, so
 *     a 4:3 source means nothing important gets cropped out).
 *  2. Drop the PNG into design/uploads/, run `npm run optimize-images`,
 *     reference the resulting /uploads/*.webp path in `image`.
 *  3. Tune marker x/y by loading the page locally.
 *  4. Provide pl/en/es strings for every localized field.
 */
export const LOOKS: Look[] = [];
```

- [ ] **Step 4: Run the test — expect it to pass (vacuously — empty array)**

```bash
npx vitest run src/lib/looks.test.ts
```

Expected: PASS (all suites pass on an empty array).

- [ ] **Step 5: Commit**

```bash
git add src/lib/looks.ts src/lib/looks.test.ts
git commit -m "feat(inspiracje): add localized Look data model + integrity tests"
```

---

## Task 2: Per-piece anchor on ProductTile (deep-link target)

**Files:**
- Edit: `src/components/shop/ProductTile.tsx`

The legend (Task 3) deep-links each available piece to `/{category}#piece-{id}`. That anchor must exist on the collection page. `ProductTile` currently exposes `data-product-id={product.id}` but no DOM `id`, so fragment navigation has nothing to scroll to. Add a stable `id` and a `scroll-margin-top` so the sticky header doesn't cover the landed tile. This is a tiny, backward-compatible addition (no behaviour change for existing callers).

- [ ] **Step 1: Add the `id` and scroll offset to the tile root**

In `src/components/shop/ProductTile.tsx`, find the root `<div>` opening (currently):

```tsx
    <div
      className={`tile${product.sold ? ' sold' : ''}${selected ? ' selected' : ''}`}
      onClick={() => {
```

Add an `id` and an inline `scroll-margin-top` (clearing the sticky header). The `style` goes right after `className`:

```tsx
    <div
      id={`piece-${product.id}`}
      style={{ scrollMarginTop: 'calc(var(--header-h) + 16px)' }}
      className={`tile${product.sold ? ' sold' : ''}${selected ? ' selected' : ''}`}
      onClick={() => {
```

Leave every other attribute (`data-testid`, `data-product-id`, `data-category`, …) unchanged.

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 3: Verify the anchor works in dev**

```bash
npm run dev
```

Open `http://localhost:3000/wazony#piece-v01` (use any real id from that category). Expect: the page scrolls so the matching tile sits just below the sticky header, not hidden behind it.

- [ ] **Step 4: Commit**

```bash
git add src/components/shop/ProductTile.tsx
git commit -m "feat(shop): add per-piece id anchor to ProductTile for deep-linking"
```

---

## Task 3: LookBlock component

**Files:**
- Create: `src/components/editorial/LookBlock.tsx`
- Create: `src/components/editorial/LookBlock.css`

`LookBlock` is an async React server component. It receives the active `locale` and a `soldIds` set from the page. It resolves product prices via `getProductById()` + `pln()`, renders numbered markers on the photo, and renders the legend below. Sold pieces are dimmed and show the localized "sold" label (reusing `gallery.sold`) instead of a price + link. Available pieces link to `/{category}#piece-{id}`. UI chrome strings come from the `inspiracje` message section (Task 4). CSS is colocated, BEM-style, token-driven.

- [ ] **Step 1: Create `src/components/editorial/LookBlock.css`**

```css
/* ============================================================
   LookBlock — editorial "Inspiracje" section component
   ============================================================ */

.look-block {
  padding: var(--section-y) 0;
  border-bottom: 1px solid var(--c-line);
}

/* Two-column grid: text (1fr) | photo (1.55fr). DOM order is text-then-photo. */
.look-block__grid {
  display: grid;
  grid-template-columns: 1fr 1.55fr;
  gap: clamp(32px, 5vw, 72px);
  align-items: center;
  margin-bottom: clamp(24px, 3vw, 36px);
}

/* Reverse layout (odd-index looks): swap columns visually via `order` while
   keeping the DOM/tab order text-first. Track sizes are mirrored so the photo
   stays the wide column on both sides. */
.look-block--reverse .look-block__grid {
  grid-template-columns: 1.55fr 1fr;
}
.look-block--reverse .look-block__photo-wrap {
  order: 1;
}
.look-block--reverse .look-block__text {
  order: 2;
}

/* ── Text column ───────────────────────────────────────────── */

.look-block__eyebrow {
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--c-terracotta);
  margin-bottom: 14px;
}

.look-block__title {
  font-family: var(--f-display);
  font-size: clamp(28px, 3.5vw, 44px);
  font-weight: 700;
  line-height: 1.08;
  letter-spacing: -0.01em;
  color: var(--c-espresso);
  margin-bottom: 18px;
}

.look-block__editorial {
  font-size: 14px;
  line-height: 1.75;
  color: var(--c-espresso);
  margin-bottom: 24px;
}

.look-block__cta {
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--c-terracotta);
  border-bottom: 1px solid var(--c-terracotta);
  padding-bottom: 2px;
  display: inline-block;
  text-decoration: none;
}

/* ── Photo column ──────────────────────────────────────────── */

.look-block__photo-wrap {
  position: relative;
}

.look-block__photo {
  width: 100%;
  aspect-ratio: 4 / 3;
  border-radius: var(--r-sharp);
  display: block;
  object-fit: cover;
}

/* Numbered marker circles pinned on the photo. x/y arrive as inline % styles. */
.look-block__marker {
  position: absolute;
  width: 26px;
  height: 26px;
  background: var(--c-terracotta);
  color: var(--c-paper);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  transform: translate(-50%, -50%);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  pointer-events: none;
  user-select: none;
}

.look-block__marker--sold {
  opacity: 0.45;
}

/* ── Legend row ────────────────────────────────────────────── */

.look-block__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 20px;
  padding-top: 16px;
}

.look-block__legend-item {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 13px;
  color: var(--c-espresso);
  text-decoration: none;
}

a.look-block__legend-item:hover .look-block__legend-name {
  color: var(--c-terracotta);
}

.look-block__legend-item--sold {
  opacity: 0.55;
}

.look-block__legend-num {
  width: 22px;
  height: 22px;
  background: var(--c-terracotta);
  color: var(--c-paper);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
  flex-shrink: 0;
}

.look-block__legend-name {
  font-weight: 500;
}

.look-block__legend-price {
  color: color-mix(in srgb, var(--c-espresso) 60%, var(--c-paper));
}

.look-block__legend-sold {
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-size: 10px;
  color: color-mix(in srgb, var(--c-espresso) 60%, var(--c-paper));
}

.look-block__legend-arrow {
  color: var(--c-line);
  font-size: 11px;
}

/* ── Mobile (< 861px) ──────────────────────────────────────── */

@media (max-width: 860px) {
  /* Single column; clear the desktop order/track swaps so text stacks above photo. */
  .look-block__grid,
  .look-block--reverse .look-block__grid {
    grid-template-columns: 1fr;
    gap: 24px;
  }
  .look-block--reverse .look-block__photo-wrap,
  .look-block--reverse .look-block__text {
    order: 0;
  }
}
```

- [ ] **Step 2: Create `src/components/editorial/LookBlock.tsx`**

```tsx
import { getTranslations } from 'next-intl/server';
import { getProductById } from '@/lib/products';
import { pln } from '@/lib/format';
import { Link } from '@/i18n/navigation';
import type { Locale } from '@/i18n/routing';
import type { Look } from '@/lib/looks';
import './LookBlock.css';

type Props = {
  look: Look;
  index: number;
  locale: Locale;
  /** Product ids currently sold (from getSoldIds), merged at render time. */
  soldIds: Set<string>;
};

export async function LookBlock({ look, index, locale, soldIds }: Props) {
  const t = await getTranslations();
  const isReverse = index % 2 !== 0;
  const legendId = `look-legend-${look.id}`;

  return (
    <section className={`look-block${isReverse ? ' look-block--reverse' : ''}`}>
      <div className="look-block__grid">

        {/* Text column — DOM-first so mobile stacks text above photo */}
        <div className="look-block__text">
          <div className="look-block__eyebrow">
            {t('inspiracje.lookLabel')} &middot; {String(index + 1).padStart(2, '0')}
          </div>
          <h2 className="look-block__title">{look.title[locale]}</h2>
          <p className="look-block__editorial">{look.editorial[locale]}</p>
          <a className="look-block__cta" href={`#${legendId}`}>
            {t('inspiracje.shopThisLook')} →
          </a>
        </div>

        {/* Photo column — swapped visually on desktop via CSS `order` */}
        <div className="look-block__photo-wrap">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="look-block__photo"
            src={look.image}
            alt={look.imageAlt[locale]}
            width={1200}
            height={900}
          />
          {look.markers.map((marker) => {
            const sold = soldIds.has(marker.productId);
            return (
              <div
                key={marker.num}
                className={`look-block__marker${sold ? ' look-block__marker--sold' : ''}`}
                style={{ left: `${marker.x}%`, top: `${marker.y}%` }}
                aria-hidden="true"
              >
                {marker.num}
              </div>
            );
          })}
        </div>
      </div>

      {/* Legend — resolves productId → price, reflects sold state, deep-links the piece */}
      <div id={legendId} className="look-block__legend">
        {look.markers.map((marker) => {
          const product = getProductById(marker.productId);
          if (!product) return null;
          const sold = soldIds.has(marker.productId);
          const name = marker.label[locale];

          if (sold) {
            return (
              <span
                key={marker.num}
                className="look-block__legend-item look-block__legend-item--sold"
              >
                <span className="look-block__legend-num">{marker.num}</span>
                <span className="look-block__legend-name">{name}</span>
                <span className="look-block__legend-sold">{t('gallery.sold')}</span>
              </span>
            );
          }

          return (
            <Link
              key={marker.num}
              className="look-block__legend-item"
              href={`/${product.category}#piece-${product.id}`}
            >
              <span className="look-block__legend-num">{marker.num}</span>
              <span className="look-block__legend-name">{name}</span>
              <span className="look-block__legend-price">{pln(product.price)}</span>
              <span className="look-block__legend-arrow" aria-hidden="true">→</span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit
```

Expected: no errors related to `LookBlock.tsx` or `looks.ts`. (Full wiring is verified in Task 5 once the page exists.)

- [ ] **Step 4: Commit**

```bash
git add src/components/editorial/LookBlock.tsx src/components/editorial/LookBlock.css
git commit -m "feat(inspiracje): add sold-aware, localized LookBlock component"
```

---

## Task 4: Messages

**Files:**
- Edit: `messages/pl.json`
- Edit: `messages/en.json`
- Edit: `messages/es.json`

Add `nav.inspiracje`, `title.inspiracje`, and a new top-level `inspiracje` section to each file. The `inspiracje` section holds: page header (`eyebrow`, `h1`, `intro`), metadata (`metaDesc`), the per-block chrome (`lookLabel`, `shopThisLook`), the empty-state (`comingSoon`), and the CTA band (`ctaH`, `ctaBtn`). The legend's "sold" label reuses the existing `gallery.sold` key — do not add a new one.

- [ ] **Step 1: Edit `messages/pl.json`**

In the `"title"` object, add after `"studio": "O studiu",`:
```json
    "inspiracje": "Inspiracje — ceramika w kontekście",
```

In the `"nav"` object, add after `"studio": "O studiu",`:
```json
    "inspiracje": "Inspiracje",
```

Add a new top-level `"inspiracje"` object (place it after the `"nav"` object's closing brace):
```json
  "inspiracje": {
    "eyebrow": "Inspiracje",
    "h1": "Ceramika w kontekście",
    "intro": "Wnętrza, które ją pokazują. Każde ułożenie to osobna historia — i kilka kawałków, które możesz zabrać do siebie.",
    "metaDesc": "Ceramika Anny Ciok w kontekście wnętrz — inspiracje stylistyczne i kawałki do kupienia.",
    "lookLabel": "Zestaw",
    "shopThisLook": "Kup ten zestaw",
    "comingSoon": "Już wkrótce.",
    "ctaH": "Każda forma jest jedyna w swoim rodzaju",
    "ctaBtn": "Przeglądaj sklep"
  },
```

- [ ] **Step 2: Edit `messages/en.json`**

In `"title"`, add after the studio entry:
```json
    "inspiracje": "Inspirations — ceramics in context",
```

In `"nav"`, add after the studio entry:
```json
    "inspiracje": "Inspirations",
```

Add the top-level `"inspiracje"` object:
```json
  "inspiracje": {
    "eyebrow": "Inspirations",
    "h1": "Ceramics in context",
    "intro": "Interiors that show them off. Each arrangement is its own story — and a few pieces you can take home.",
    "metaDesc": "Anna Ciok ceramics in interior settings — styling inspiration and pieces available to buy.",
    "lookLabel": "The Look",
    "shopThisLook": "Shop this look",
    "comingSoon": "Coming soon.",
    "ctaH": "Every form is one of a kind",
    "ctaBtn": "Browse the shop"
  },
```

- [ ] **Step 3: Edit `messages/es.json`**

In `"title"`, add after the studio entry:
```json
    "inspiracje": "Inspiraciones — cerámica en contexto",
```

In `"nav"`, add after the studio entry:
```json
    "inspiracje": "Inspiraciones",
```

Add the top-level `"inspiracje"` object:
```json
  "inspiracje": {
    "eyebrow": "Inspiraciones",
    "h1": "Cerámica en contexto",
    "intro": "Interiores que la muestran. Cada composición es su propia historia — y algunas piezas que puedes llevarte a casa.",
    "metaDesc": "Cerámica de Anna Ciok en ambientes interiores — inspiración y piezas disponibles.",
    "lookLabel": "El conjunto",
    "shopThisLook": "Compra este conjunto",
    "comingSoon": "Muy pronto.",
    "ctaH": "Cada forma es única en su clase",
    "ctaBtn": "Explorar tienda"
  },
```

> **Exact-key reminder:** the keys consumed by code are `title.inspiracje`, `nav.inspiracje`, `inspiracje.eyebrow`, `inspiracje.h1`, `inspiracje.intro`, `inspiracje.metaDesc`, `inspiracje.lookLabel`, `inspiracje.shopThisLook`, `inspiracje.comingSoon`, `inspiracje.ctaH`, `inspiracje.ctaBtn`, and the reused `gallery.sold`. Spell them identically in all three files.

- [ ] **Step 4: Validate JSON parses**

```bash
node -e "for (const f of ['pl','en','es']) { JSON.parse(require('fs').readFileSync('messages/'+f+'.json','utf8')); console.log(f, 'ok'); }"
```

Expected: `pl ok` / `en ok` / `es ok` (no parse errors from trailing commas, etc.).

- [ ] **Step 5: Commit**

```bash
git add messages/pl.json messages/en.json messages/es.json
git commit -m "feat(inspiracje): add trilingual nav, title, and page copy keys"
```

---

## Task 5: Page + sitemap registration

**Files:**
- Edit: `src/lib/site.ts`
- Create: `src/app/[locale]/inspiracje/page.tsx`

The page follows the same shape as `src/app/[locale]/o-studiu/page.tsx` (`setRequestLocale`, `getTranslations`, `generateMetadata` with `alternatesFor`). It additionally fetches `getSoldIds()` (guarded — a DB blip must not 500 the page) and passes a `Set` plus the `locale` into each `LookBlock`. Registering `/inspiracje` in `SITE_PATHS` makes it appear in the sitemap and hreflang cluster automatically (both derive from `SITE_PATHS`).

- [ ] **Step 1: Add `/inspiracje` to `SITE_PATHS`**

In `src/lib/site.ts`, the `SITE_PATHS` array currently contains `'/o-studiu',`. Add `/inspiracje` immediately before it:

```typescript
  '/inspiracje',
  '/o-studiu',
```

(Result: `…'/koszyk', '/inspiracje', '/o-studiu', '/kontakt',…`.)

- [ ] **Step 2: Create `src/app/[locale]/inspiracje/page.tsx`**

```tsx
import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Metadata } from 'next';
import { Link } from '@/i18n/navigation';
import { Icon } from '@/components/ui/Icon';
import { alternatesFor } from '@/lib/seo/urls';
import { getSoldIds } from '@/lib/inventory';
import { LOOKS } from '@/lib/looks';
import { LookBlock } from '@/components/editorial/LookBlock';
import type { Locale } from '@/i18n/routing';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale });
  return {
    title: t('title.inspiracje'),
    description: t('inspiracje.metaDesc'),
    alternates: alternatesFor(locale as Locale, '/inspiracje'),
    openGraph: {
      images: LOOKS[0]?.image ? [{ url: LOOKS[0].image }] : [],
    },
  };
}

export default async function InspiracjePage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale });

  // Sold state — same source collection pages use, merged at render. A DB blip
  // must not break the editorial page, so degrade to "all available" on error.
  let soldIds = new Set<string>();
  try {
    soldIds = new Set(await getSoldIds());
  } catch {
    soldIds = new Set<string>();
  }

  return (
    <main>
      {/* ── PAGE HEADER ──────────────────────────────────────── */}
      {/*
        page-head-inner is a 1fr 1.05fr grid at ≥861px (copy + art). This page
        has no art column, so force single-column via inline style; the rest of
        page-head styling (padding, background, h1 font) still applies.
      */}
      <section className="page-head">
        <div className="page-head-inner" style={{ gridTemplateColumns: '1fr' }}>
          <div className="page-head-copy">
            <div className="eyebrow">{t('inspiracje.eyebrow')}</div>
            <h1>{t('inspiracje.h1')}</h1>
            <p className="lead">{t('inspiracje.intro')}</p>
          </div>
        </div>
      </section>

      {/* ── LOOK BLOCKS ──────────────────────────────────────── */}
      <div className="section-inner">
        {LOOKS.map((look, i) => (
          <LookBlock
            key={look.id}
            look={look}
            index={i}
            locale={locale as Locale}
            soldIds={soldIds}
          />
        ))}

        {LOOKS.length === 0 && (
          <p
            style={{
              padding: 'var(--section-y) 0',
              color: 'var(--c-line)',
              textAlign: 'center',
            }}
          >
            {t('inspiracje.comingSoon')}
          </p>
        )}
      </div>

      {/* ── CTA BAND ─────────────────────────────────────────── */}
      <section className="section cta-band">
        <div className="cta-band-inner">
          <h2>{t('inspiracje.ctaH')}</h2>
          <Link className="btn btn-primary" href="/sklep">
            <span>{t('inspiracje.ctaBtn')}</span>
            <Icon name="arrow" className="btn-arrow" />
          </Link>
        </div>
      </section>
    </main>
  );
}
```

- [ ] **Step 3: Run the linter**

```bash
npm run lint
```

Expected: no errors in `src/app/[locale]/inspiracje/page.tsx` or `src/lib/site.ts`.

- [ ] **Step 4: Verify the page renders (empty state) in dev**

```bash
npm run dev
```

Open `http://localhost:3000/inspiracje`, then `/en/inspiracje` and `/es/inspiracje`. Expect on each: localized eyebrow / h1 / intro, the localized "coming soon" placeholder (PL/EN/ES respectively), and the CTA band. No console errors.

- [ ] **Step 5: Confirm sitemap registration**

```bash
node -e "console.log(require('./src/lib/site.ts'))" 2>/dev/null || rg -n "inspiracje" src/lib/site.ts
```

Expected: `'/inspiracje'` appears in `SITE_PATHS` (the `rg` fallback prints the line). Since `sitemap.ts` maps `SITE_PATHS`, the route is now in the sitemap + hreflang cluster automatically.

- [ ] **Step 6: Commit**

```bash
git add src/lib/site.ts "src/app/[locale]/inspiracje/page.tsx"
git commit -m "feat(inspiracje): add /inspiracje page + register in sitemap paths"
```

---

## Task 6: Navigation (guarded on content)

**Files:**
- Edit: `src/components/layout/Header.tsx`
- Edit: `src/components/layout/Footer.tsx`

Add the "Inspiracje" link to the desktop nav, the mobile drawer (via Header's `mobileLinks`), and the footer Studio column. **Guard each on `LOOKS.length > 0`** so the link is hidden until the page actually has content — this avoids advertising an empty "coming soon" page in production navigation. `MobileMenu.tsx` needs no change (it renders whatever `links` Header passes).

- [ ] **Step 1: Edit `src/components/layout/Header.tsx`**

Add the `LOOKS` import after the existing imports:

```tsx
import { LOOKS } from '@/lib/looks';
```

Replace the `mobileLinks` array so the Inspiracje entry is included only when content exists:

```tsx
  const mobileLinks = [
    { href: '/sklep', label: t('nav.sklep') },
    ...(LOOKS.length > 0 ? [{ href: '/inspiracje', label: t('nav.inspiracje') }] : []),
    { href: '/o-studiu', label: t('nav.studio') },
    { href: '/kontakt', label: t('nav.kontakt') },
  ];
```

In the desktop `nav-left`, add the guarded link between sklep and o-studiu:

```tsx
          <nav className="nav-left">
            <Link className="nav-link" href="/sklep">{t('nav.sklep')}</Link>
            {LOOKS.length > 0 && (
              <Link className="nav-link" href="/inspiracje">{t('nav.inspiracje')}</Link>
            )}
            <Link className="nav-link" href="/o-studiu">{t('nav.studio')}</Link>
          </nav>
```

- [ ] **Step 2: Edit `src/components/layout/Footer.tsx`**

Add the `LOOKS` import after the existing imports:

```tsx
import { LOOKS } from '@/lib/looks';
```

In the Studio column (`<h5>{t('footer.hStudio')}</h5>`), add a guarded list item after the `/o-studiu#proces` item:

```tsx
          {/* Studio column */}
          <div className="footer-col">
            <h5>{t('footer.hStudio')}</h5>
            <ul>
              <li>
                <Link href="/o-studiu">{t('footer.oArtystce')}</Link>
              </li>
              <li>
                <Link href="/o-studiu#proces">{t('footer.proces')}</Link>
              </li>
              {LOOKS.length > 0 && (
                <li>
                  <Link href="/inspiracje">{t('nav.inspiracje')}</Link>
                </li>
              )}
              <li>
                <Link href="/kontakt">{t('nav.kontakt')}</Link>
              </li>
            </ul>
          </div>
```

- [ ] **Step 3: Run the linter**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 4: Verify guard behaviour in dev**

```bash
npm run dev
```

`LOOKS` is still empty at this point, so confirm the **negative** case: open `http://localhost:3000` and verify the Inspiracje link is **absent** from desktop nav, mobile drawer, and footer (the page is still reachable by direct URL). The link's appearance is verified after Task 7 adds content.

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/Header.tsx src/components/layout/Footer.tsx
git commit -m "feat(inspiracje): wire nav + footer links (shown once LOOKS has content)"
```

---

## Task 7: Add first real look (content wiring)

**Files:**
- Edit: `src/lib/looks.ts`

This turns the empty-state page into a real editorial page and reveals the (guarded) nav links. Repeat these steps whenever a new look is added. Requires interior photography from Anna.

- [ ] **Step 1: Add the image to the pipeline**

Drop the photo into `design/uploads/look-01.png` (export it at a **4:3 aspect ratio** — see the comment in `looks.ts`), then:

```bash
npm run optimize-images
```

Confirm `public/uploads/look-01.webp` is created.

- [ ] **Step 2: Add the look entry to `src/lib/looks.ts`**

Replace `export const LOOKS: Look[] = [];` with the following. Substitute the placeholder `productId`s (`k04`, `v02`, `t01`) with the real ids of pieces visible in the photo, and translate each localized field:

```typescript
export const LOOKS: Look[] = [
  {
    id: 'slow-morning',
    title: {
      pl: 'Powolny poranek',
      en: 'A slow morning',
      es: 'Una mañana lenta',
    },
    editorial: {
      pl: 'Szeroki kubek ogrzewający dłonie. Mały talerz na okruchy tostów. Te kawałki powstały z myślą o niepośpiesznej godzinie — tej przed początkiem dnia, kiedy wszystko jest jeszcze ciche.',
      en: 'A wide mug to warm your hands. A small plate for toast crumbs. These pieces were made for the unhurried hour — the one before the day begins, while everything is still quiet.',
      es: 'Una taza ancha para calentar las manos. Un platito para las migas de la tostada. Estas piezas nacieron para la hora sin prisa — la de antes de que empiece el día, cuando todo aún está en silencio.',
    },
    image: '/uploads/look-01.webp',
    imageAlt: {
      pl: 'Poranne nakrycie stołu z ceramiką Anny Ciok',
      en: 'A morning table setting with Anna Ciok ceramics',
      es: 'Una mesa puesta por la mañana con cerámica de Anna Ciok',
    },
    markers: [
      { num: 1, productId: 'k04', label: { pl: 'Kubek', en: 'Mug', es: 'Taza' }, x: 24, y: 38 },
      { num: 2, productId: 'v02', label: { pl: 'Wazon', en: 'Vase', es: 'Jarrón' }, x: 62, y: 55 },
      { num: 3, productId: 't01', label: { pl: 'Talerz', en: 'Plate', es: 'Plato' }, x: 45, y: 72 },
    ],
  },
];
```

- [ ] **Step 3: Run the integrity tests**

```bash
npx vitest run src/lib/looks.test.ts
```

Expected: all suites pass. A wrong `productId` fails the "resolve via getProductById" test with the offending id; a missing translation fails the localization test naming the field + locale.

- [ ] **Step 4: Tune markers + verify the page locally**

```bash
npm run dev
```

Open `http://localhost:3000/inspiracje` and adjust each marker's `x`/`y` until the circles sit on the right pieces. Then confirm across locales:
- `/inspiracje`, `/en/inspiracje`, `/es/inspiracje` show the look title, editorial, and legend labels in the matching language.
- Legend prices render; clicking an **available** entry lands on `/{category}` scrolled to the exact piece (the Task 2 anchor).
- If any featured piece is sold, its marker is dimmed and its legend entry shows the localized "sold" label instead of a price/link.
- The Inspiracje link now **appears** in desktop nav, mobile drawer, and footer (Task 6 guard satisfied).

- [ ] **Step 5: Commit**

```bash
git add src/lib/looks.ts public/uploads/look-01.webp
git commit -m "feat(inspiracje): add first look — slow morning"
```

---

## Self-Review

**Spec/recommendation coverage check:**

| Requirement | Task |
|-------------|------|
| New standalone `/inspiracje` page | Task 5 |
| `looks.ts` data file | Task 1 |
| `LookBlock` component | Task 3 |
| Alternating L/R layout (order swap, tab order preserved) | Task 3 (CSS) |
| Numbered markers on photo | Task 3 |
| Product legend below grid | Task 3 |
| `getProductById` price lookup + `pln()` display | Task 3 |
| Page header (eyebrow, h1, intro) | Task 5 |
| CTA band → /sklep | Task 5 |
| `generateMetadata` + `alternatesFor` | Task 5 |
| Nav + footer links | Task 6 |
| **#1 Trilingual look content** (no Polish leak to EN/ES) | Task 1 (Localized) + Task 3 + Task 7 |
| **#2 UI chrome from messages** (no hardcoded strings) | Task 3 + Task 4 |
| **#3 Registered in sitemap / hreflang** | Task 5 (`SITE_PATHS`) |
| **#4 Token-driven CSS** (no hardcoded hex) | Task 3 (CSS) |
| **#5 Stronger integrity tests** (label/image/markers/sequential nums) | Task 1 |
| **#6 Sold-state handling** (`getSoldIds`, dim + delist) | Task 3 + Task 5 |
| **#7 Deep-link to the piece** (collection anchor) | Task 2 + Task 3 |
| **#8 No empty page in nav** (guarded links) | Task 6 |
| **#9 No dead CSS** (marker hover/transition removed) | Task 3 (CSS) |
| **#10 4:3 authoring caveat documented** | Task 1 (looks.ts comment) + Task 7 |
| **#11 `order` swap instead of `direction:rtl`** | Task 3 (CSS) |

**Type consistency:** `Localized` is defined once (Task 1) and consumed identically in `LookBlock` (Task 3) and content (Task 7). `LookBlock` props `{ look, index, locale, soldIds }` match the page's call site (Task 5). The `id="piece-{id}"` anchor format (Task 2) matches the legend's `href={`/${product.category}#piece-${product.id}`}` (Task 3).

**Placeholder scan:** No TBD/TODO/"handle edge cases" — every code step shows complete code; `productId`/marker-coordinate substitution in Task 7 is genuine author input, not a code placeholder.

All recommendations (#1–#11) are implemented.
```

