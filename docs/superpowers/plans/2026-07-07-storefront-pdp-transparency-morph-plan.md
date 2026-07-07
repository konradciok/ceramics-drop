# PDP Transparency + View-Transition Morph (Spec C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface honest all-in cost on the ceramic PDP (C-core), and add a tile→hero view-transition morph as a separate enhancement PR (C-morph).

**Architecture:** C-core is a server-rendered delivery block on the PDP computed from existing `pricing.ts` constants — zero new client JS. C-morph rides Next's experimental `viewTransition` flag + React's `ViewTransition` shared-element names, gated by reduced-motion, and ships in its own PR that begins with a compatibility spike.

**Tech Stack:** Next.js App Router server components, next-intl, plain CSS, Vitest (helper), Playwright (`@ci`), React `ViewTransition` (experimental).

**Spec:** `docs/superpowers/specs/2026-07-07-storefront-pdp-transparency-morph-design.md`

## Global Constraints

- **Do not modify `src/styles/tokens.css`.** Build stays **`next build --webpack`**. Styling stays **plain CSS**.
- Mobile-first; **`prefers-reduced-motion` respected**.
- **Preserve the `(pdp)` route group's no-`loading.tsx` behavior** — `notFound()` must keep returning a real HTTP 404; do not add a `loading.tsx` to `(pdp)`.
- Monetary display uses major units via `currencyFormatter`; PLN/EUR/GBP only (USD/CAD fall back to EUR until their tables land).

---

## File Structure

**PR 1 — C-core:**
- **Modify** `src/lib/pricing.ts` — add `shippingOfCurrency(currency, method)` (mirrors `priceOfCurrency`; de-dupes the inline selector in `CartView.tsx:242`).
- **Modify** `src/lib/pricing.test.ts` — **extend** the existing test file (it already has extensive coverage) with a `shippingOfCurrency` describe block. Do NOT recreate it.
- **Modify** `src/components/shop/CartView.tsx:242` — use the shared helper (no behavior change).
- **Create** `src/components/shop/PdpDelivery.tsx` — server component: estimated total + options + trust line.
- **Modify** `src/components/shop/ProductPageScreen.tsx` — render `<PdpDelivery>` above `<AddToCartButton>`.
- **Modify** `messages/{pl,en,es,de}.json` — new `pdp` namespace (2 keys).
- **Modify** `src/styles/site.css` — `.pdp-delivery*` styles.
- **Create** `e2e/pdp-transparency.spec.ts` — `@ci` assertion.

**Note — cart mirror already satisfied:** `CartView`'s summary already shows pieces subtotal, delivery, and total (`CartView.tsx:811–822`), so the spec's "cart mirror" needs **no new work**. C-core is the PDP block only.

**PR 2 — C-morph** (separate PR, after C-core):
- **Modify** `next.config.*` — `experimental.viewTransition: true`.
- **Modify** `src/components/shop/ProductTile.tsx` + `src/components/shop/ProductPageGallery.tsx` — `ViewTransition` names on the tile image + PDP hero.
- **Create** `src/components/shop/FocusHeadingOnMorph.tsx` — focus-routing island.
- **Modify** `src/styles/motion.css` — reduced-motion gate for `::view-transition-*`.
- **Create** `e2e/pdp-morph.spec.ts` — 404 preservation + focus routing.

---

# PR 1 — C-core (pricing & shipping transparency)

### Task 1: Shared `shippingOfCurrency` helper

**Files:**
- Modify: `src/lib/pricing.ts`
- Modify (extend): `src/lib/pricing.test.ts` (already exists — add a describe block, do not recreate)
- Modify: `src/components/shop/CartView.tsx:242`

**Interfaces:**
- Produces: `shippingOfCurrency(currency: Currency, method: DeliveryMethod): number` — display shipping price in major units.

- [ ] **Step 1: Write the failing test**

`src/lib/pricing.test.ts` **already exists**. Add `shippingOfCurrency` to its existing `./pricing` import, and append this describe block (do not recreate the file):

```ts
describe('shippingOfCurrency', () => {
  it('returns the per-currency flat shipping in major units', () => {
    expect(shippingOfCurrency('pln', 'paczkomat')).toBe(20);
    expect(shippingOfCurrency('eur', 'kurier')).toBe(10);
    expect(shippingOfCurrency('gbp', 'kurier')).toBe(12);
    expect(shippingOfCurrency('pln', 'odbior')).toBe(0);
  });
  // Intentional asymmetry: priceOfCurrency THROWS for usd/cad (no price table),
  // so the item price is computed before shipping is ever read — usd/cad never
  // reach shippingOfCurrency in a real flow. Its EUR default is only exercised
  // for the real switchable currencies. This test documents that, it isn't a
  // claim that usd/cad shipping is "supported".
  it('routes non-switchable currencies through the EUR default (unreachable in practice)', () => {
    expect(shippingOfCurrency('usd', 'paczkomat')).toBe(shippingOfCurrency('eur', 'paczkomat'));
  });
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run src/lib/pricing.test.ts`
Expected: FAIL — `shippingOfCurrency` is not exported.

- [ ] **Step 3: Add the helper to `src/lib/pricing.ts`**

Add after `priceOfCurrency` (near line 188):

```ts
/**
 * Display shipping price (major units) for a delivery method in a display
 * currency. usd/cad hit the EUR default, but — unlike priceOfCurrency, which
 * THROWS for usd/cad — that path is never reached in practice: the item price
 * (priceOfCurrency) is computed first and throws, so no usd/cad order gets as
 * far as reading shipping. The asymmetry is deliberate and safe.
 */
export function shippingOfCurrency(currency: Currency, method: DeliveryMethod): number {
  switch (currency) {
    case 'pln':
      return SHIPPING_PLN[method];
    case 'gbp':
      return SHIPPING_GBP[method];
    case 'eur':
    default:
      return SHIPPING_EUR[method];
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/lib/pricing.test.ts`
Expected: PASS.

- [ ] **Step 5: De-dupe `CartView`'s inline selector**

In `src/components/shop/CartView.tsx`, add `shippingOfCurrency` to the existing `pricing` import (line 33), then replace the inline `shippingOf` (lines 242–243):

```ts
  const shippingOf = (method: ShipId) => shippingOfCurrency(currency, method);
```

- [ ] **Step 6: Verify no cart regression + commit**

Run: `npm run lint && npm run build`
Expected: clean.

```bash
git add src/lib/pricing.ts src/lib/pricing.test.ts src/components/shop/CartView.tsx
git commit -m "refactor(pricing): shared shippingOfCurrency helper

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 2: PDP delivery block

**Files:**
- Create: `src/components/shop/PdpDelivery.tsx`
- Modify: `src/components/shop/ProductPageScreen.tsx`
- Modify: `messages/{pl,en,es,de}.json`
- Modify: `src/styles/site.css`
- Test: `e2e/pdp-transparency.spec.ts` (create)

**Interfaces:**
- Consumes: `shippingOfCurrency` (Task 1), `priceOfCurrency`, `currencyFormatter`.
- Produces: `<PdpDelivery product={Product} currency={Currency} />`; DOM hooks `[data-testid="pdp-delivery"]`, `[data-testid="pdp-est-total"]`.

- [ ] **Step 1: Write the failing test**

Create `e2e/pdp-transparency.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

// C-core: the PDP shows an all-in estimated total = item + locker shipping, per
// display currency. `@ci` lives in each title so `--grep @ci` selects them.
// Amounts mirror src/lib/pricing.test.ts: kubki = PLN 95 / EUR 25 / GBP 22;
// paczkomat = PLN 20 / EUR 5 / GBP 5.
test('@ci PDP estimated total includes locker shipping — PLN', async ({ page }) => {
  // pl → PLN. 95 + 20 = 115.
  await page.goto('/kubki/k01');
  await expect(page.getByTestId('pdp-est-total')).toHaveText(/115\s*zł/);
  await expect(page.getByTestId('pdp-delivery')).toContainText(/20\s*zł/); // locker option
});

test('@ci PDP estimated total includes locker shipping — EUR', async ({ page }) => {
  // /en defaults to EUR (no CF-IPCountry in test). 25 + 5 = 30.
  await page.goto('/en/kubki/k01');
  await expect(page.getByTestId('pdp-est-total')).toHaveText(/30\s*€/);
});

test('@ci PDP estimated total includes locker shipping — GBP', async ({ page }) => {
  // /en + currency_pref=gbp → GBP. 22 + 5 = 27. gbp() formats as "£27".
  await page.goto('/en/kubki/k01');
  await page.context().addCookies([{ name: 'currency_pref', value: 'gbp', url: page.url() }]);
  await page.reload();
  await expect(page.getByTestId('pdp-est-total')).toHaveText(/£\s*27/);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx playwright test e2e/pdp-transparency.spec.ts` (against local `npm run dev`).
Expected: FAIL — no `pdp-est-total` element yet.

- [ ] **Step 3: Add the `pdp` namespace to all four message files**

In each of `messages/pl.json`, `en.json`, `es.json`, `de.json`, add a top-level `"pdp"` block (place it near the existing `"lightbox"` block). Copy is checkout-scoped so it stays accurate even where downstream import charges may apply (the UK/GBP caveat from the spec):

`pl.json`:
```json
  "pdp": {
    "estimatedFrom": "Szacunkowo od",
    "trust": "Cena, którą widzisz, to cena, którą płacisz — bez ukrytych opłat przy kasie."
  },
```
`en.json`:
```json
  "pdp": {
    "estimatedFrom": "Estimated from",
    "trust": "The price you see is the price you pay — no hidden fees at checkout."
  },
```
`es.json`:
```json
  "pdp": {
    "estimatedFrom": "Estimado desde",
    "trust": "El precio que ves es el precio que pagas — sin cargos ocultos al finalizar."
  },
```
`de.json`:
```json
  "pdp": {
    "estimatedFrom": "Geschätzt ab",
    "trust": "Der angezeigte Preis ist der Endpreis — keine versteckten Kosten an der Kasse."
  },
```

> **Studio-confirmation dependency (from the spec):** before merge, confirm with the studio whether a stronger "no customs" claim is wanted for UK/GBP. The wording above is deliberately checkout-scoped and safe without that sign-off.

- [ ] **Step 4: Create `src/components/shop/PdpDelivery.tsx`**

```tsx
import { getTranslations } from 'next-intl/server';
import { currencyFormatter } from '@/lib/format';
import { priceOfCurrency, shippingOfCurrency } from '@/lib/pricing';
import type { Currency } from '@/lib/currency';
import type { Product } from '@/lib/types';

/** Server-rendered all-in cost transparency for a ceramic PDP. */
export async function PdpDelivery({ product, currency }: { product: Product; currency: Currency }) {
  const t = await getTranslations();
  const { fmt } = currencyFormatter(currency);
  const item = priceOfCurrency(product, currency);
  const locker = shippingOfCurrency(currency, 'paczkomat');
  const courier = shippingOfCurrency(currency, 'kurier');

  return (
    <div className="pdp-delivery" data-testid="pdp-delivery">
      <div className="pdp-delivery-est">
        <span className="k">{t('pdp.estimatedFrom')}</span>
        <span className="v" data-testid="pdp-est-total">{fmt(item + locker)}</span>
      </div>
      <ul className="pdp-delivery-opts">
        <li><span>{t('ship.pickupT')}</span><span>{t('cart.free')}</span></li>
        <li><span>{t('ship.paczkomatT')}</span><span>{fmt(locker)}</span></li>
        <li><span>{t('ship.courierT')}</span><span>{fmt(courier)}</span></li>
      </ul>
      <p className="pdp-delivery-trust">{t('pdp.trust')}</p>
    </div>
  );
}
```

- [ ] **Step 5: Render it in `ProductPageScreen`**

In `src/components/shop/ProductPageScreen.tsx`: add `import { PdpDelivery } from './PdpDelivery';` and render it just before `<AddToCartButton product={product} />` (line 79):

```tsx
              <PdpDelivery product={product} currency={currency} />
              <AddToCartButton product={product} />
```

- [ ] **Step 6: Add styles to `src/styles/site.css`**

Append (compose existing tokens only):

```css
/* ─── PDP delivery transparency (Spec C-core) ─────────────────── */
.pdp-delivery { margin: 20px 0; padding: 16px 0; border-top: 1px solid var(--c-line-soft); }
.pdp-delivery-est { display: flex; justify-content: space-between; align-items: baseline; font-size: 17px; }
.pdp-delivery-est .v { font-weight: 500; }
.pdp-delivery-opts { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 4px; }
.pdp-delivery-opts li { display: flex; justify-content: space-between; font-size: 14px; opacity: .8; }
.pdp-delivery-trust { margin: 12px 0 0; font-size: 13px; opacity: .7; }
```

- [ ] **Step 7: Run the test + lint + build, then commit**

```bash
npx playwright test e2e/pdp-transparency.spec.ts
npm run lint && npm run build
```
Expected: PASS; clean.

```bash
git add src/components/shop/PdpDelivery.tsx src/components/shop/ProductPageScreen.tsx messages src/styles/site.css e2e/pdp-transparency.spec.ts
git commit -m "feat(pdp): all-in cost transparency block (Spec C-core)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

# PR 2 — C-morph (tile→hero view-transition, enhancement)

> Ships **after** C-core, in its own PR. It rides React's experimental `ViewTransition`; **Task 3 is a compatibility spike** — if the API is unavailable or regresses global navigation under the Workers runtime, C-morph is cut (the spec marks it cuttable) and C-core stands alone.

### Task 3: Compatibility spike — enable the flag, verify no global-nav regression

**Files:**
- Modify: `next.config.*` (the repo's Next config file)

- [ ] **Step 1: Enable the experimental flag**

Add to the Next config's `experimental` object:

```js
experimental: {
  viewTransition: true,
},
```

- [ ] **Step 2: Confirm the API surface**

Verify `import { ViewTransition } from 'react'` resolves in a throwaway component under the installed React/Next version. If it does not export `ViewTransition`, **stop — C-morph is not viable on this version; keep C-core and close this PR.** (Confirm against the installed version's docs via Context7 `/vercel/next.js`.)

- [ ] **Step 3: Verify no unintended global transitions**

Run `npm run build` and `npm run preview:cf`; click through home → collection → PDP → back. Expected: navigation behaves as before (no unexpected crossfades), pages render, and a bad URL (`/kubki/zzz`) still returns a real 404. (If the Cloudflare Workers/Builds MCP is available, use it to confirm the deployed preview's runtime logs are clean.)

- [ ] **Step 4: Commit (flag only)**

```bash
git add next.config.*
git commit -m "chore(config): enable experimental viewTransition (spike)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 4: Shared-element names + reduced-motion gate + focus routing

**Files:**
- Modify: `src/components/shop/ProductTileLink.tsx` (navigating source — **not** `ProductTile`, which opens the lightbox), `src/components/shop/ProductPageGallery.tsx`
- Create: `src/components/shop/FocusHeadingOnMorph.tsx`
- Modify: `src/components/shop/ProductPageScreen.tsx` (heading id + island + pass `heroName`), `src/styles/motion.css`
- Test: `e2e/pdp-morph.spec.ts` (create)

**Interfaces:**
- Consumes: `ViewTransition` from `react`; the spike (Task 3) confirmed availability.
- Produces: matched `name={\`product-${id}\`}` on the `ProductTileLink` image and the PDP hero image; `<FocusHeadingOnMorph headingId="pdp-heading" />`.

> **Why not the collection grid?** `Gallery`'s `ProductTile` opens the **lightbox** for unsold pieces (`onOpen`; the crawlable `.tile-link` is `preventDefault`ed), so it does not navigate — a morph there never fires. Scope is `ProductTileLink` (PDP "more from" → next PDP), a real `<Link>`. Also, naming the `ProductTile` image would risk a duplicate `product-<id>` whenever a lightbox is open. The lightbox-permalink morph is deferred (spike finding).

- [ ] **Step 1: Write the failing tests**

Create `e2e/pdp-morph.spec.ts`:

```ts
import { test, expect } from '@playwright/test';

// `@ci` in each title for `--grep @ci` selection.
test('@ci missing product still returns a real 404 (no loading shell)', async ({ page }) => {
  const res = await page.goto('/kubki/zzz');
  expect(res?.status()).toBe(404);
});

test('@ci navigating a "more from" tile routes focus to the PDP heading', async ({ page }) => {
  // Start on a PDP so the "more from" strip (ProductTileLink) is present, then
  // navigate PDP → PDP via a real link (not the lightbox-opening grid tile).
  await page.goto('/kubki/k01');
  await page.locator('.pdp-more .tile-static').first().click();
  await page.waitForURL(/\/kubki\/k\d+/);
  await expect(page.locator('#pdp-heading')).toBeFocused();
});
```

- [ ] **Step 2: Run them, verify they fail**

Run: `npx playwright test e2e/pdp-morph.spec.ts`
Expected: the focus test FAILS (heading not focused yet); the 404 test should already pass (guard against regression).

- [ ] **Step 3: Name the source — `ProductTileLink` + set the morph flag**

`ProductTileLink` is currently a server component. Add `'use client'` at the top, import `{ ViewTransition } from 'react'`, wrap its `<img>` in a named `ViewTransition`, and set the focus-routing flag when the link is clicked:

```tsx
'use client';
import { ViewTransition } from 'react';
// …existing imports (Link, srcSet, types)…

    <Link
      href={`/${product.category}/${product.id}`}
      className="tile-static"
      aria-label={displayName}
      onClick={() => sessionStorage.setItem('acc_morph', '1')}
    >
      <ViewTransition name={`product-${product.id}`} share="auto">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={product.image} srcSet={srcSet(product.image)} sizes="(min-width:1101px) 25vw, (min-width:561px) 33vw, 50vw" alt={displayName} loading="lazy" />
      </ViewTransition>
      {/* …existing .tile-static-meta + sold-tag… */}
    </Link>
```

(Converting this tiny tile to a client component is the cost of the morph; it's small and self-contained.)

- [ ] **Step 4: Name the target (hero) + focus-routing island**

Create `src/components/shop/FocusHeadingOnMorph.tsx`:

```tsx
'use client';
import { useEffect } from 'react';

/**
 * View transitions abandon focus when the old page is removed. When a PDP is
 * reached via a morph link (flagged in sessionStorage by ProductTileLink), move
 * focus to the heading so screen-reader users land on the new page title.
 * Direct loads/refreshes have no flag, so focus is never stolen on normal loads.
 */
export function FocusHeadingOnMorph({ headingId }: { headingId: string }) {
  useEffect(() => {
    if (sessionStorage.getItem('acc_morph') !== '1') return;
    sessionStorage.removeItem('acc_morph');
    document.getElementById(headingId)?.focus();
  }, [headingId]);
  return null;
}
```

In `src/components/shop/ProductPageGallery.tsx`, import `{ ViewTransition } from 'react'` and wrap the hero (first) image in `<ViewTransition name={heroName} share="auto">`, where `heroName` is a new prop. In `src/components/shop/ProductPageScreen.tsx`: pass `heroName={\`product-${product.id}\`}` to `ProductPageGallery`, give the `<h1>` `id="pdp-heading" tabIndex={-1}` (line 60), and render `<FocusHeadingOnMorph headingId="pdp-heading" />` inside the `<article>`.

- [ ] **Step 5: Reduced-motion gate in `motion.css`**

Append:

```css
/* Spec C-morph: no morph under reduced motion. */
@media (prefers-reduced-motion: reduce) {
  ::view-transition-group(*),
  ::view-transition-old(*),
  ::view-transition-new(*) { animation: none !important; }
}
```

- [ ] **Step 6: Run tests + lint + build + preview, then commit**

```bash
npx playwright test e2e/pdp-morph.spec.ts
npm run lint && npm run build && npm run preview:cf
```
Expected: both tests PASS; 404 preserved; no global-nav regression.

```bash
git add src/components/shop src/styles/motion.css e2e/pdp-morph.spec.ts
git commit -m "feat(pdp): tile→hero view-transition morph (Spec C-morph)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- C-core estimated total + options + trust line → Task 2. ✓
- Anchored on locker (paczkomat) → Task 2 Step 4 (`item + locker`). ✓
- Cart mirror → already satisfied by existing `CartView` summary (noted; no task needed). ✓
- Reuses existing shipping copy + `shippingOfCurrency` helper → Tasks 1–2. ✓
- UK/GBP copy dependency → Task 2 Step 3 note + checkout-scoped wording. ✓
- C-morph via Next experimental `viewTransition` → Tasks 3–4. ✓
- `@supports`/reduced-motion gate → Task 4 Step 5. ✓
- Focus-routing a11y fix → Task 4 Step 4. ✓
- Real-404 preservation, no `loading.tsx` → Task 3 Step 3 + Task 4 test. ✓
- Metric (add-to-cart / PDP→checkout) → instrumentation deferred per spec; no code task. ✓

**2. Placeholder scan:** No TBD/TODO. Task 3 Step 2 is a real go/no-go spike gate (experimental dependency), not a deferred placeholder — if it fails, C-morph is cut and C-core stands. The Next config file path is written as `next.config.*` because the repo's exact extension (`.ts`/`.mjs`/`.js`) is confirmed at the file in Step 1.

**3. Type consistency:** `shippingOfCurrency(currency, method)` signature is identical in Task 1 (definition), Task 1 Step 5 (CartView use), and Task 2 Step 4 (PdpDelivery use). `product-${id}` name and `#pdp-heading`/`acc_morph` keys match across Task 4 steps and the test. ✓
