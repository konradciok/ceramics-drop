# Collection Bento (Spec B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a controlled feature-rhythm ("light bento") layout + scroll reveals to the collection grid, piloted on one category, reusing `Gallery`/`ProductTile` unchanged in behavior.

**Architecture:** A deterministic `featureKind(index)` rule designates sparse larger tiles; `ProductTile` gains a `feature` size modifier; `.gallery--bento` uses CSS Grid `dense` packing; reveals + the family-switcher edge-fade come from Spec A. Rollout is a one-line prop gated to a pilot category.

**Tech Stack:** React client components, CSS Grid, Vitest (rule), Playwright (`@ci`), Spec A `.reveal`/`.edge-fade-x`.

**Spec:** `docs/superpowers/specs/2026-07-07-storefront-collection-bento-design.md`
**Depends on:** Spec A (`.reveal`, `.edge-fade-x`) shipped. Preserves the `view-transition-name` Spec C adds to the tile image.

## Global Constraints

- **Do not modify `src/styles/tokens.css`.** Build stays **`next build --webpack`**. Styling stays **plain CSS**.
- Product images stay native `<img>` with `srcSet()`; only the `sizes` hint changes per feature tile.
- Mobile-first; **`prefers-reduced-motion` respected** (via Spec A).
- **No change to `ProductTile`'s cart / lightbox / analytics behavior** — layout only.

---

## File Structure

- **Create** `src/lib/bento.ts` — `featureKind(index)` deterministic rule.
- **Create** `src/lib/bento.test.ts` — unit test for the rule.
- **Modify** `src/components/shop/ProductTile.tsx` — add `feature` + `reveal` props (class + `sizes`).
- **Modify** `src/styles/site.css` — `.gallery--bento`, `.tile--lead`, `.tile--wide`.
- **Modify** `src/components/shop/Gallery.tsx` — `bento` prop; pass `feature`/`reveal` per tile.
- **Modify** `src/components/shop/CollectionScreen.tsx` — pilot gate + family-switcher edge-fade.
- **Create** `e2e/collection-bento.spec.ts` — `@ci` integration test.

---

### Task 1: Deterministic feature rule

**Files:**
- Create: `src/lib/bento.ts`
- Test: `src/lib/bento.test.ts`

**Interfaces:**
- Produces: `featureKind(index: number): 'lead' | 'wide' | undefined`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/bento.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { featureKind } from './bento';

describe('featureKind', () => {
  it('heroes the first tile', () => {
    expect(featureKind(0)).toBe('lead');
  });
  it('widens every 7th tile after the lead', () => {
    expect(featureKind(7)).toBe('wide');
    expect(featureKind(14)).toBe('wide');
  });
  it('leaves the rest uniform', () => {
    for (const i of [1, 2, 3, 4, 5, 6, 8]) expect(featureKind(i)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run src/lib/bento.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/lib/bento.ts`**

```ts
/**
 * Deterministic "light bento" rhythm: the first tile is a 2×2 lead; every 7th
 * tile thereafter is a 2×1 wide. Pure and index-based so SSR and client agree.
 * Tunable: change the cadence (7) to taste.
 */
export function featureKind(index: number): 'lead' | 'wide' | undefined {
  if (index === 0) return 'lead';
  if (index % 7 === 0) return 'wide';
  return undefined;
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx vitest run src/lib/bento.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/bento.ts src/lib/bento.test.ts
git commit -m "feat(collection): deterministic bento feature rule

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 2: `ProductTile` feature/reveal props + grid CSS

**Files:**
- Modify: `src/components/shop/ProductTile.tsx`
- Modify: `src/styles/site.css`

**Interfaces:**
- Consumes: `featureKind` output type (`'lead' | 'wide' | undefined`).
- Produces: `<ProductTile … feature={'lead'|'wide'|undefined} reveal={boolean} />`; classes `.tile--lead`, `.tile--wide`, `.gallery--bento`.

- [ ] **Step 1: Add the props to `ProductTile`**

In `src/components/shop/ProductTile.tsx`, extend `Props` (line 22):

```tsx
type Props = {
  product: Product;
  onOpen?: (product: Product) => void;
  feature?: 'lead' | 'wide';
  reveal?: boolean;
};
```

Destructure `feature` and `reveal` in the signature (line 29). Compute the `sizes` hint once (feature tiles render larger, so they must request larger candidates):

```tsx
  const sizes =
    feature === 'lead' ? '(min-width:1101px) 50vw, (min-width:561px) 66vw, 100vw'
    : feature === 'wide' ? '(min-width:1101px) 50vw, (min-width:561px) 66vw, 50vw'
    : '(min-width:1101px) 25vw, (min-width:561px) 33vw, 50vw';
```

Extend the root `className` (line 46) to add the feature + reveal classes:

```tsx
    className={`tile${product.sold ? ' sold' : ''}${selected ? ' selected' : ''}${feature ? ` tile--${feature}` : ''}${reveal ? ' reveal' : ''}`}
```

Replace the hardcoded `sizes="…"` on **both** the main `<img>` (line 83) and the `<img className="tile-alt">` (line 87) with `sizes={sizes}`.

- [ ] **Step 2: Add grid CSS to `src/styles/site.css`**

Append (composes the existing `.gallery`/`.tile` rules; note the explicit height handling — feature tiles can't rely on `.tile`'s `aspect-ratio:4/5` because they span grid tracks):

```css
/* ─── Collection bento (Spec B) ───────────────────────────────── */
.gallery--bento { grid-auto-flow: dense; }

/* Lead: full-width band on mobile (needs an explicit ratio since the img is
   absolutely positioned), a 2×2 feature from 561px up (height from the tracks). */
.gallery--bento .tile--lead {
  grid-column: span 2;
  aspect-ratio: 16 / 10;
  content-visibility: visible;
}
@media (min-width: 561px) {
  .gallery--bento .tile--lead { grid-row: span 2; aspect-ratio: auto; }
  /* Wide: 2×1 from 561px up; height comes from the 1× tile sharing its row.
     On mobile it has no override → stays a normal 1× tile (keeps density). */
  .gallery--bento .tile--wide {
    grid-column: span 2;
    aspect-ratio: auto;
    content-visibility: visible;
  }
}
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run lint && npm run build`
Expected: clean (no visible change yet — `Gallery` doesn't pass `bento` until Task 3).

- [ ] **Step 4: Commit**

```bash
git add src/components/shop/ProductTile.tsx src/styles/site.css
git commit -m "feat(collection): ProductTile feature/reveal variants + bento grid CSS

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 3: Wire bento into Gallery + pilot rollout

**Files:**
- Modify: `src/components/shop/Gallery.tsx`
- Modify: `src/components/shop/CollectionScreen.tsx`
- Test: `e2e/collection-bento.spec.ts`

**Interfaces:**
- Consumes: `featureKind` (Task 1), `ProductTile` `feature`/`reveal` props (Task 2).
- Produces: `<Gallery products bento={boolean} />`.

- [ ] **Step 1: Write the failing test**

Create `e2e/collection-bento.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

// @ci — bento is piloted on /kubki only.
test('bento pilot heroes a lead tile and keeps every tile shoppable', async ({ page }) => {
  await page.goto('/kubki');
  await expect(page.locator('.gallery--bento .tile--lead').first()).toBeVisible();
  const firstTile = page.locator('[data-testid="product-tile"]').first();
  await expect(firstTile.getByTestId('add-to-cart')).toBeVisible();
  await expect(firstTile.locator('.tile-meta .pr')).toBeVisible(); // price
});

test('non-pilot category stays a uniform grid', async ({ page }) => {
  await page.goto('/wazony');
  await expect(page.locator('.gallery--bento')).toHaveCount(0);
});

test('tiles are visible under reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/kubki');
  await expect(page.locator('[data-testid="product-tile"]').first()).toBeVisible();
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx playwright test e2e/collection-bento.spec.ts`
Expected: the first test FAILS — no `.gallery--bento` yet.

- [ ] **Step 3: Add the `bento` prop to `Gallery`**

In `src/components/shop/Gallery.tsx`: import `featureKind` (`import { featureKind } from '@/lib/bento';`), extend `Props` with `bento?: boolean`, destructure it (default `false`). Add the class to the grid `<div>` (line 75):

```tsx
        <div className={`gallery${bento ? ' gallery--bento' : ''}`} data-count={visible.length}>
```

Pass the per-tile props in the map (line 76), using the visible-list index:

```tsx
          {visible.map((p, i) => (
            <ProductTile
              key={p.id}
              product={p}
              feature={bento ? featureKind(i) : undefined}
              reveal={bento}
              onOpen={(prod) => {
```

(Leave the rest of the `onOpen` body unchanged.)

- [ ] **Step 4: Pilot gate + family-switcher edge-fade in `CollectionScreen`**

In `src/components/shop/CollectionScreen.tsx`, add the pilot constant near the top of the module:

```tsx
// Bento is piloted on one category; flip to `true` for all once bounce/browse metrics clear.
const BENTO_PILOT: CategorySlug = 'kubki';
```

Pass the gate to `Gallery` (line 59):

```tsx
      <Gallery products={products} bento={slug === BENTO_PILOT} />
```

Add the Spec A edge-fade to the horizontal family switcher (line 42):

```tsx
            <div className="shop-switch edge-fade-x">
```

- [ ] **Step 5: Run the tests + lint + build, then commit**

```bash
npx playwright test e2e/collection-bento.spec.ts
npm run lint && npm run build
```
Expected: all three tests PASS; clean.

```bash
git add src/components/shop/Gallery.tsx src/components/shop/CollectionScreen.tsx e2e/collection-bento.spec.ts
git commit -m "feat(collection): pilot bento + reveals on /kubki (Spec B)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 6: (Rollout, later) After the pilot's bounce/browse metrics clear**

Change the gate in `CollectionScreen.tsx` to enable bento for every category:

```tsx
      <Gallery products={products} bento />
```

Re-run `e2e/collection-bento.spec.ts` (update the non-pilot assertion, which no longer holds), lint, build, commit as a separate rollout change.

---

## Self-Review

**1. Spec coverage:**
- Controlled feature rhythm, deterministic rule → Task 1 (`featureKind`). ✓
- Reuses `ProductTile` unchanged in behavior; only `feature`/`reveal` size+class → Task 2. ✓
- `sizes` bumped for feature tiles → Task 2 Step 1. ✓
- CSS Grid `dense`, responsive lead/wide (mobile density preserved) → Task 2 Step 2. ✓
- `.reveal` on tiles + `.edge-fade-x` on family switcher → Tasks 2–3. ✓
- Pilot one category → measure → roll (one-line flip) → Task 3 Steps 4/6. ✓
- No editorial cells interleaved → none added. ✓
- Prints collection untouched → `CollectionScreen` only (PrintCollectionScreen not modified). ✓
- Every tile keeps name/price/add → Task 3 test asserts add button + price. ✓
- Reduced-motion visible → Task 3 test. ✓

**2. Placeholder scan:** No TBD/TODO. Cadence `7` is a tunable design constant (documented), not a placeholder. Step 6 is an explicit deferred rollout, not vague future work.

**3. Type consistency:** `featureKind` returns `'lead' | 'wide' | undefined` in Task 1, consumed with the same `feature?: 'lead' | 'wide'` prop in Task 2, passed from Task 3. Class names `.gallery--bento`/`.tile--lead`/`.tile--wide` match between Task 2 CSS, Task 3 wiring, and the tests. ✓
