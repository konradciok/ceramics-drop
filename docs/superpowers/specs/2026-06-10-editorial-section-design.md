# Editorial Section — "By the Look" — Design Spec

**Date:** 2026-06-10  
**Status:** Approved

---

## Overview

A new standalone editorial page at `/inspiracje` that presents Anna's ceramic pieces in the context of curated interior shots. Each "look" pairs a full editorial photograph with 3–4 numbered markers, a short atmospheric text, and a product legend. The page scrolls through 3–4 looks stacked vertically, alternating the text/photo sides to create magazine rhythm.

---

## Route & Navigation

- **Route:** `src/app/[locale]/inspiracje/page.tsx`
- **URLs:** `/inspiracje` (PL default), `/en/inspiracje`, `/es/inspiracje`
  - Slug stays Polish across all locales — consistent with existing category slugs (`/kubki`, `/wazony`, etc.)
- **Navigation:** New "Inspiracje" entry added to:
  - Main nav (`Header.tsx`) — desktop links and mobile drawer
  - Footer links
- **Language:** Polish-first. Editorial copy lives in the data file as Polish strings. i18n can be lifted to `messages/` files in a future pass.

---

## Data Model

**`src/lib/looks.ts`** — single source of truth for all editorial content.

```ts
export interface LookMarker {
  num: number;       // shown on photo and in legend
  productId: string; // resolved via PRODUCT_BY_ID from products.ts
  x: number;         // % from left edge of the rendered image
  y: number;         // % from top edge of the rendered image
}

export interface Look {
  id: string;         // slug, e.g. 'slow-morning'
  title: string;      // e.g. 'Powolny poranek'
  editorial: string;  // one atmospheric paragraph; supports richTags *emphasis*
  image: string;      // path in /public, e.g. '/uploads/look-01.webp'
  imageAlt: string;
  markers: LookMarker[];
}

export const LOOKS: Look[] = [];
```

**Key decisions:**
- Product metadata (name, price, category slug) is resolved at render time from `PRODUCT_BY_ID` — no duplication
- Marker coordinates are percentages of the rendered image dimensions, so they stay accurate at any viewport width (same natural-ratio approach established in PR #54)
- Images go through the existing `npm run optimize-images` pipeline (PNG → WebP)
- `editorial` string is compatible with the existing `richTags` component for inline emphasis

---

## Components

### `src/components/editorial/LookBlock.tsx`

Server component. Props: `look: Look`, `index: number`.

**Layout:**
- Even index (`0, 2, …`) → text column left, photo column right
- Odd index (`1, 3, …`) → photo column left, text column right (CSS `direction: rtl` trick, same as mockup)
- Grid: `1fr 1.55fr` (text : photo ratio)

**Text column contains:**
1. Eyebrow label: `The Look · 01` (terracotta, small-caps tracking)
2. Large title (`--f-display`, ~44px desktop, ~28px mobile)
3. Editorial paragraph (body copy, ~14px, generous line-height)
4. "Kup ten zestaw →" inline CTA — anchors down to the legend row

**Photo column contains:**
- `<img>` at natural aspect ratio (4:3 recommended for interior shots), `object-fit: cover`
- Absolutely-positioned marker circles: terracotta `--c-terracotta` background, white numeral, 26px diameter
- A second marker colour (`--c-periwinkle`) is available for visual variety within a single look

**Legend row (below the grid):**
- `display: flex; flex-wrap: wrap` row of items
- Each item: coloured number circle + product name + price (grosze converted to PLN via `pln()`) + `→` link to the product's collection page
- No sold/available state shown — the linked collection page handles that (v2 concern)

**Mobile (`< --bp-md` = 861px):**
- Grid collapses to single column
- Order: text block → photo (full width) → legend
- Markers remain on photo at same percentage coordinates

### `src/app/[locale]/inspiracje/page.tsx`

Thin async server component.

```tsx
import { LOOKS } from '@/lib/looks'
import LookBlock from '@/components/editorial/LookBlock'

export default async function InspiracjePage() {
  return (
    <>
      <PageHeader />
      {LOOKS.map((look, i) => <LookBlock key={look.id} look={look} index={i} />)}
      <CtaBand />
    </>
  )
}
```

`generateMetadata()` returns static Polish title/description. OG image = first look's `image` path.

---

## Page Structure

1. **Page header**
   - Eyebrow: `By the Look` (terracotta, tracked uppercase)
   - H1: `Ceramika w kontekście` (~56px)
   - Intro: one sentence describing the concept (~480px max-width)
   - Separated from look blocks by a `--c-line` rule + `--section-y` padding

2. **Look blocks** — `LookBlock` components, each separated by a `--c-line` rule

3. **CTA band** — reuses existing site pattern, links to `/sklep`
   - Copy: "Każda forma jest jedyna w swoim rodzaju" + "Przeglądaj sklep" button

---

## Styling

- **No new CSS dependencies** — uses existing token system from `tokens.css`
- New CSS file: `src/components/editorial/LookBlock.css` — colocated with the component
- Marker circles: `position: absolute`, `transform: translate(-50%, -50%)`, hover scales to 1.15 via `--ease` transition
- Typography scale: title uses `--f-display`, eyebrow and CTA use heavy letter-spacing (`0.15–0.2em`)
- Dividers: `1px solid var(--c-line)`

---

## SEO

- `generateMetadata()` with Polish title + description
- OG image: first look's photo (leverages existing OG setup)
- No JSON-LD needed for v1 (editorial, not product schema)

---

## Out of Scope (v1)

- **Sold/available status** on legend items — the collection page handles this; editorial page links there
- **i18n of editorial copy** — Polish strings live in `looks.ts`; lift to `messages/` when localising
- **Inventory-aware legend** — show sold state in legend (v2)
- **Animated scroll effects** (parallax, kinetic type) — keep it clean for v1
- **CMS integration** — not needed; static data file is sufficient

---

## Files Changed

| File | Action |
|------|--------|
| `src/lib/looks.ts` | New — data model + `LOOKS` array |
| `src/components/editorial/LookBlock.tsx` | New — reusable look component |
| `src/components/editorial/LookBlock.css` | New — component styles |
| `src/app/[locale]/inspiracje/page.tsx` | New — page |
| `src/components/layout/Header.tsx` | Edit — add nav link |
| `src/components/layout/Footer.tsx` | Edit — add footer link |
| `src/components/layout/MobileMenu.tsx` | Edit — add mobile nav item |
| `messages/pl.json` | Edit — page title, intro, CTA copy |
| `messages/en.json` | Edit — nav label + page meta strings only (editorial copy stays in `looks.ts` as Polish) |
| `messages/es.json` | Edit — nav label + page meta strings only (editorial copy stays in `looks.ts` as Polish) |
