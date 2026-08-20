# Editorial Section — "By the Look" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a new `/inspiracje` page presenting ceramic pieces in curated interior shots, each look labelled with numbered markers and a product legend.

**Architecture:** A `src/lib/looks.ts` data file holds all editorial content (mirroring `products.ts`). A `LookBlock` server component renders each look with alternating text/photo layout. The page maps over `LOOKS` and is wired into nav/footer.

**Tech Stack:** Next.js 16 App Router, next-intl, TypeScript, plain CSS (custom properties from `tokens.css`), Vitest for unit tests.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/lib/looks.ts` | Create | Data model + `LOOKS` array |
| `src/lib/looks.test.ts` | Create | Validate marker integrity |
| `src/components/editorial/LookBlock.tsx` | Create | Reusable look component (server) |
| `src/components/editorial/LookBlock.css` | Create | Component styles |
| `messages/pl.json` | Edit | Page copy + nav label |
| `messages/en.json` | Edit | Nav label + meta strings |
| `messages/es.json` | Edit | Nav label + meta strings |
| `src/app/[locale]/inspiracje/page.tsx` | Create | Route page + metadata |
| `src/components/layout/Header.tsx` | Edit | Add "Inspiracje" nav link |
| `src/components/layout/Footer.tsx` | Edit | Add "Inspiracje" footer link |
| `src/components/layout/MobileMenu.tsx` | No change | Receives `links` prop — no edit needed |

> **Note on MobileMenu:** It receives a `links` prop from `Header.tsx`. Adding the link to `mobileLinks` in Header is sufficient — `MobileMenu.tsx` itself does not need to be touched.

---

## Task 1: Data model

**Files:**
- Create: `src/lib/looks.ts`
- Create: `src/lib/looks.test.ts`

### Why `label` on LookMarker

The legend needs a display name (e.g. "Kubek", "Wazon"). `PRODUCT_BY_ID` is not exported; only `getProductById()` is. Product data has `category` (a slug like `kubki`) and `num` (like `04`), but no ready-made Polish display name. Adding a `label` field to `LookMarker` gives Anna full editorial control without adding a slug→display-name mapping.

- [ ] **Step 1: Write the failing test**

Create `src/lib/looks.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { LOOKS } from './looks';
import { getProductById } from './products';

describe('LOOKS', () => {
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

  it('no duplicate marker nums within a look', () => {
    for (const look of LOOKS) {
      const nums = look.markers.map((m) => m.num);
      expect(new Set(nums).size, `look ${look.id} has duplicate marker nums`).toBe(nums.length);
    }
  });

  it('all look ids are unique', () => {
    const ids = LOOKS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
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
export interface LookMarker {
  /** Number shown on the photo and in the legend (1, 2, 3…). */
  num: number;
  /** Product id from products.ts, e.g. 'k04'. Validated by looks.test.ts. */
  productId: string;
  /** Display name for the legend, e.g. 'Kubek'. Author-controlled. */
  label: string;
  /** Horizontal position on the photo, % from left edge. */
  x: number;
  /** Vertical position on the photo, % from top edge. */
  y: number;
}

export interface Look {
  /** URL-safe slug, e.g. 'slow-morning'. */
  id: string;
  /** Polish title shown in the text column, e.g. 'Powolny poranek'. */
  title: string;
  /** One atmospheric paragraph. Plain text for v1. */
  editorial: string;
  /** Path in /public, e.g. '/uploads/look-01.webp'. Run npm run optimize-images first. */
  image: string;
  /** Alt text for the photo. */
  imageAlt: string;
  markers: LookMarker[];
}

/**
 * Editorial looks — "By the Look" page data.
 *
 * Add entries here when Anna shoots a new interior look.
 * Drop the PNG into design/uploads/, run `npm run optimize-images`,
 * then reference the resulting WebP path in `image`.
 * Tune marker x/y coordinates by viewing the page locally.
 */
export const LOOKS: Look[] = [];
```

- [ ] **Step 4: Run the test — expect it to pass (vacuously — empty array)**

```bash
npx vitest run src/lib/looks.test.ts
```

Expected: PASS (all 4 tests pass on an empty array).

- [ ] **Step 5: Commit**

```bash
git add src/lib/looks.ts src/lib/looks.test.ts
git commit -m "feat(editorial): add Look data model + integrity tests"
```

---

## Task 2: LookBlock component

**Files:**
- Create: `src/components/editorial/LookBlock.tsx`
- Create: `src/components/editorial/LookBlock.css`

The component is a React server component. It reads product data via `getProductById()` from `products.ts` and prices via `pln()` from `format.ts`. CSS lives in a colocated file using BEM-style class names.

- [ ] **Step 1: Create `src/components/editorial/LookBlock.css`**

```css
/* ============================================================
   LookBlock — editorial "By the Look" section component
   ============================================================ */

.look-block {
  padding: var(--section-y) 0;
  border-bottom: 1px solid var(--c-line);
}

/* Two-column grid: text (1fr) | photo (1.55fr) */
.look-block__grid {
  display: grid;
  grid-template-columns: 1fr 1.55fr;
  gap: clamp(32px, 5vw, 72px);
  align-items: center;
  margin-bottom: clamp(24px, 3vw, 36px);
}

/* Reverse layout (odd-index looks): use direction:rtl to swap columns
   without reordering DOM (preserves logical tab order). */
.look-block--reverse .look-block__grid {
  direction: rtl;
}

.look-block--reverse .look-block__grid > * {
  direction: ltr;
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
  color: #5a4a3a;
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

/* Numbered marker circles pinned on the photo */
.look-block__marker {
  position: absolute;
  width: 26px;
  height: 26px;
  background: var(--c-terracotta);
  color: #fff;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  /* Coordinates are set via inline style as %; centre the circle on that point */
  transform: translate(-50%, -50%);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  pointer-events: none;
  user-select: none;
  transition: transform var(--ease, ease) 0.15s;
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

.look-block__legend-item:hover .look-block__legend-name {
  color: var(--c-terracotta);
}

.look-block__legend-num {
  width: 22px;
  height: 22px;
  background: var(--c-terracotta);
  color: #fff;
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
  color: #8a7a6a;
}

.look-block__legend-arrow {
  color: var(--c-line);
  font-size: 11px;
}

/* ── Mobile (< 861px) ──────────────────────────────────────── */

@media (max-width: 860px) {
  /* Reset to single column; direction:rtl no longer needed */
  .look-block__grid,
  .look-block--reverse .look-block__grid {
    grid-template-columns: 1fr;
    direction: ltr;
    gap: 24px;
  }
}
```

- [ ] **Step 2: Create `src/components/editorial/LookBlock.tsx`**

```tsx
import { getProductById } from '@/lib/products';
import { pln } from '@/lib/format';
import { Link } from '@/i18n/navigation';
import type { Look } from '@/lib/looks';
import './LookBlock.css';

type Props = { look: Look; index: number };

export function LookBlock({ look, index }: Props) {
  const isReverse = index % 2 !== 0;
  const legendId = `look-legend-${look.id}`;

  return (
    <section className={`look-block${isReverse ? ' look-block--reverse' : ''}`}>
      <div className="look-block__grid">

        {/* Text column — DOM-first so mobile stacks text above photo */}
        <div className="look-block__text">
          <div className="look-block__eyebrow">
            The Look &middot; {String(index + 1).padStart(2, '0')}
          </div>
          <h2 className="look-block__title">{look.title}</h2>
          <p className="look-block__editorial">{look.editorial}</p>
          <a className="look-block__cta" href={`#${legendId}`}>
            Kup ten zestaw →
          </a>
        </div>

        {/* Photo column — comes second in DOM; swapped visually on desktop via CSS */}
        <div className="look-block__photo-wrap">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            className="look-block__photo"
            src={look.image}
            alt={look.imageAlt}
            width={1200}
            height={900}
          />
          {look.markers.map((marker) => (
            <div
              key={marker.num}
              className="look-block__marker"
              style={{ left: `${marker.x}%`, top: `${marker.y}%` }}
              aria-hidden="true"
            >
              {marker.num}
            </div>
          ))}
        </div>
      </div>

      {/* Legend — resolves productId to price via getProductById */}
      <div id={legendId} className="look-block__legend">
        {look.markers.map((marker) => {
          const product = getProductById(marker.productId);
          if (!product) return null;
          return (
            <Link
              key={marker.num}
              className="look-block__legend-item"
              href={`/${product.category}`}
            >
              <span className="look-block__legend-num">{marker.num}</span>
              <span className="look-block__legend-name">{marker.label}</span>
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

Expected: no errors related to `LookBlock.tsx` or `looks.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/components/editorial/LookBlock.tsx src/components/editorial/LookBlock.css
git commit -m "feat(editorial): add LookBlock component + styles"
```

---

## Task 3: Messages

**Files:**
- Edit: `messages/pl.json`
- Edit: `messages/en.json`
- Edit: `messages/es.json`

Add keys in three places in each file: `nav`, `title`, and a new `inspiracje` section.

- [ ] **Step 1: Add keys to `messages/pl.json`**

In the `"nav"` object, add after `"studio"`:
```json
"inspiracje": "Inspiracje"
```

In the `"title"` object, add after `"studio"`:
```json
"inspiracje": "By the Look — Ceramika w kontekście"
```

Add a new top-level `"inspiracje"` section (after `"title"` is fine):
```json
"inspiracje": {
  "eyebrow": "By the Look",
  "h1": "Ceramika w kontekście",
  "intro": "Wnętrza, które ją pokazują. Każde ułożenie to osobna historia — i kilka kawałków, które możesz zabrać do siebie.",
  "metaDesc": "Ceramika Anny Ciok w kontekście wnętrz — inspiracje stylistyczne i kawałki do kupienia.",
  "ctaH": "Każda forma jest jedyna w swoim rodzaju",
  "ctaBtn": "Przeglądaj sklep"
}
```

- [ ] **Step 2: Add keys to `messages/en.json`**

In `"nav"`, add after `"studio"`:
```json
"inspiracje": "Inspirations"
```

In `"title"`, add after `"studio"`:
```json
"inspiracje": "By the Look — Ceramics in Context"
```

Add new top-level `"inspiracje"` section:
```json
"inspiracje": {
  "eyebrow": "By the Look",
  "h1": "Ceramics in context",
  "intro": "Interiors that show them off. Each arrangement is its own story — and a few pieces you can take home.",
  "metaDesc": "Anna Ciok ceramics in interior settings — styling inspiration and pieces available to buy.",
  "ctaH": "Every form is one of a kind",
  "ctaBtn": "Browse the shop"
}
```

- [ ] **Step 3: Add keys to `messages/es.json`**

In `"nav"`, add after `"studio"`:
```json
"inspiracje": "Inspiraciones"
```

In `"title"`, add after `"studio"`:
```json
"inspiracje": "By the Look — Cerámica en Contexto"
```

Add new top-level `"inspiracje"` section:
```json
"inspiracje": {
  "eyebrow": "By the Look",
  "h1": "Cerámica en contexto",
  "intro": "Interiores que la muestran. Cada composición es su propia historia — y algunas piezas que puedes llevarte a casa.",
  "metaDesc": "Cerámica de Anna Ciok en ambientes interiores — inspiración y piezas disponibles.",
  "ctaH": "Cada forma es única en su clase",
  "ctaBtn": "Explorar tienda"
}
```

- [ ] **Step 4: Commit**

```bash
git add messages/pl.json messages/en.json messages/es.json
git commit -m "feat(editorial): add inspiracje i18n keys (nav, title, page copy)"
```

---

## Task 4: Page

**Files:**
- Create: `src/app/[locale]/inspiracje/page.tsx`

Follows the exact same pattern as `src/app/[locale]/o-studiu/page.tsx`: `setRequestLocale`, `getTranslations`, `generateMetadata` with `alternatesFor`.

- [ ] **Step 1: Create `src/app/[locale]/inspiracje/page.tsx`**

```tsx
import { getTranslations, setRequestLocale } from 'next-intl/server';
import type { Metadata } from 'next';
import { Link } from '@/i18n/navigation';
import { Icon } from '@/components/ui/Icon';
import { alternatesFor } from '@/lib/seo/urls';
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

  return (
    <main>
      {/* ── PAGE HEADER ──────────────────────────────────────── */}
      {/*
        page-head-inner is a 1fr 1.05fr grid at ≥861px (designed for copy + art).
        This page has no art column, so force single-column via inline style.
        page-head styles (padding, background, h1 font) still apply as normal.
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
          <LookBlock key={look.id} look={look} index={i} />
        ))}

        {LOOKS.length === 0 && (
          <p style={{ padding: 'var(--section-y) 0', color: 'var(--c-line)', textAlign: 'center' }}>
            Coming soon.
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

- [ ] **Step 2: Run linter**

```bash
npm run lint
```

Expected: no errors in `src/app/[locale]/inspiracje/page.tsx`.

- [ ] **Step 3: Run the dev server and open the page**

```bash
npm run dev
```

Open `http://localhost:3000/inspiracje`. Expect: page header with "By the Look" eyebrow, h1 "Ceramika w kontekście", intro text, "Coming soon." placeholder, and CTA band. No JS errors in console.

- [ ] **Step 4: Commit**

```bash
git add src/app/[locale]/inspiracje/page.tsx
git commit -m "feat(editorial): add /inspiracje page"
```

---

## Task 5: Navigation

**Files:**
- Edit: `src/components/layout/Header.tsx`
- Edit: `src/components/layout/Footer.tsx`

`MobileMenu.tsx` needs no changes — it renders whatever `links` the Header passes in.

- [ ] **Step 1: Edit `src/components/layout/Header.tsx`**

Add "Inspiracje" to both `mobileLinks` and the desktop `nav-left`.

Find the `mobileLinks` array and add the new entry:

```tsx
const mobileLinks = [
  { href: '/sklep', label: t('nav.sklep') },
  { href: '/inspiracje', label: t('nav.inspiracje') },
  { href: '/o-studiu', label: t('nav.studio') },
  { href: '/kontakt', label: t('nav.kontakt') },
];
```

Find the desktop `nav-left` and add the link between sklep and o-studiu:

```tsx
<nav className="nav-left">
  <Link className="nav-link" href="/sklep">{t('nav.sklep')}</Link>
  <Link className="nav-link" href="/inspiracje">{t('nav.inspiracje')}</Link>
  <Link className="nav-link" href="/o-studiu">{t('nav.studio')}</Link>
</nav>
```

- [ ] **Step 2: Edit `src/components/layout/Footer.tsx`**

In the Studio column (`footer-col` that contains `/o-studiu` links), add a new list item:

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
    <li>
      <Link href="/inspiracje">{t('nav.inspiracje')}</Link>
    </li>
    <li>
      <Link href="/kontakt">{t('nav.kontakt')}</Link>
    </li>
  </ul>
</div>
```

- [ ] **Step 3: Run linter**

```bash
npm run lint
```

Expected: no errors.

- [ ] **Step 4: Verify in dev server**

```bash
npm run dev
```

Open `http://localhost:3000`. Confirm:
- Desktop nav shows "Sklep · Inspiracje · O studiu" on the left
- Mobile drawer (hamburger) includes "Inspiracje" between Sklep and O studiu
- Footer studio column shows "Inspiracje" link
- Clicking nav link reaches `/inspiracje` page without errors

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/Header.tsx src/components/layout/Footer.tsx
git commit -m "feat(editorial): wire Inspiracje into site nav and footer"
```

---

## Task 6: Add first real look (content wiring)

**Files:**
- Edit: `src/lib/looks.ts`

The page currently shows "Coming soon." This task adds the first real look once Anna provides interior photography. Follow these steps whenever a new look is added.

- [ ] **Step 1: Add image to pipeline**

Drop the photo PNG into `design/uploads/look-01.png`, then:

```bash
npm run optimize-images
```

Confirm `/public/uploads/look-01.webp` is created.

- [ ] **Step 2: Add look entry to `src/lib/looks.ts`**

Replace `export const LOOKS: Look[] = [];` with:

```typescript
export const LOOKS: Look[] = [
  {
    id: 'slow-morning',
    title: 'Powolny poranek',
    editorial:
      'Szeroki kubek ogrzewający dłonie. Mały talerz na okruchy tostów. Te kawałki powstały z myślą o niepośpiesznej godzinie — tej przed początkiem dnia, kiedy wszystko jest jeszcze ciche.',
    image: '/uploads/look-01.webp',
    imageAlt: 'Poranne nakrycie stołu z ceramiką Anny Ciok',
    markers: [
      { num: 1, productId: 'k04', label: 'Kubek', x: 24, y: 38 },
      { num: 2, productId: 'v02', label: 'Wazon', x: 62, y: 55 },
      { num: 3, productId: 't01', label: 'Talerz', x: 45, y: 72 },
    ],
  },
];
```

Replace `k04`, `v02`, `t01` with the actual product IDs visible in the photo. Adjust `x`/`y` percentages by loading `http://localhost:3000/inspiracje` and inspecting marker positions visually.

- [ ] **Step 3: Run tests**

```bash
npx vitest run src/lib/looks.test.ts
```

Expected: 4 tests pass. If a `productId` is wrong you'll get a clear error message.

- [ ] **Step 4: Check the page locally**

Open `http://localhost:3000/inspiracje`. Confirm:
- Photo renders with markers at correct positions
- Legend shows product labels, prices, and working links to collection pages
- "Coming soon." placeholder is gone

- [ ] **Step 5: Commit**

```bash
git add src/lib/looks.ts public/uploads/look-01.webp
git commit -m "feat(editorial): add first look — Powolny poranek"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|-----------------|------|
| New standalone page `/inspiracje` | Task 4 |
| `looks.ts` data file | Task 1 |
| `LookBlock` component | Task 2 |
| Alternating L/R layout | Task 2 (CSS `.look-block--reverse`) |
| Numbered markers on photo | Task 2 (`.look-block__marker`) |
| Product legend below grid | Task 2 (`.look-block__legend`) |
| `getProductById` for price lookup | Task 2 (LookBlock.tsx) |
| `pln()` for price display | Task 2 (LookBlock.tsx) |
| Page header (eyebrow, h1, intro) | Task 4 |
| CTA band → /sklep | Task 4 |
| `generateMetadata` + `alternatesFor` | Task 4 |
| Nav + footer links | Task 5 |
| Polish-first copy | Task 3 |
| EN + ES nav label + meta | Task 3 |

All spec requirements are covered. Task 6 is the content-wiring step that turns the empty-state page into a real editorial page — it depends on photography from Anna.
