# Client Funnel Analytics Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the print funnel's analytics blind spot (no `view_item`, `view_item_list`, or `remove_from_cart` — prints "appear from nowhere" on `add_to_cart` in GA4/Meta reporting) and stop `begin_checkout` from inflating on checkout retries.

**Architecture:** Three new print-specific event builders in `src/lib/analytics.ts`, mirroring the existing `buildPrintAddToCartEvent` pattern exactly (prints aren't `Product`s, so they build `AnalyticsItem` objects directly instead of going through `toAnalyticsItem`). Two new small client components (`PrintViewAnalytics`, `PrintCollectionAnalytics`) mirror the existing `ProductViewAnalytics`/`Gallery` fire-on-mount pattern. `remove_from_cart` is wired directly into `CartView.tsx`'s existing print-removal button. `begin_checkout` gets a sessionStorage dedup guard keyed by `attemptId`, mirroring the existing `pushPaymentFailedOnce` per-PaymentIntent guard.

**Tech Stack:** Next.js 16 App Router (React Server + Client Components), TypeScript, Vitest.

## Global Constraints

- Source audit: `docs/audits/event-system-audit.md`, findings F-07 (Medium) and F-09 (Medium).
- Test runner is Vitest: `npx vitest run <path>`. `vitest.config.ts` sets `environment: 'node'` and `include: ['src/**/*.test.ts', 'scripts/**/*.test.ts']` — **`.tsx` component files cannot be unit-tested in this repo today** (no jsdom, no `.test.tsx` inclusion, no `@testing-library/react` dependency). This applies equally to the existing `ProductViewAnalytics`/`Gallery`/`GroupedGallery` components (none of them have component-mount tests either) — this plan follows that same, already-accepted pattern: pure builder functions in `analytics.ts`/`checkout-analytics.ts` get full unit-test coverage; the new client components that call them are verified manually via GTM Preview (Task 5).
- Scope is exactly what the audit's own remediation table (section H, row 2.3) lists: `view_item`, `view_item_list`, `remove_from_cart` for prints, and `begin_checkout` dedup. `select_item` for print tiles is explicitly **out of scope** — print tiles are plain `<Link>` elements with no click handler (unlike ceramic tiles, which open a lightbox), so adding it would mean converting the tile itself into a client component, a bigger structural change the audit's remediation table does not ask for.
- Commit after each task.

---

### Task 1: Print PDP `view_item` (F-07)

**Files:**
- Modify: `src/lib/analytics.ts`
- Test: `src/lib/analytics.test.ts`
- Create: `src/components/shop/PrintViewAnalytics.tsx`
- Modify: `src/components/shop/PrintProductScreen.tsx`

**Interfaces:**
- Produces: `buildPrintViewItemEvent(print: { id: string; num: string; variantLabel: string; price: number }, options?: EventOptions): DataLayerEvent`.
- Consumes (in the new component): `pushDataLayer` from `@/lib/analytics`, `useCurrency` from `@/components/currency/CurrencyProvider`, `currencyFormatter` from `@/lib/format` — the exact same imports `ProductViewAnalytics.tsx` already uses.

- [ ] **Step 1: Write the failing test**

In `src/lib/analytics.test.ts`, add `buildPrintViewItemEvent` to the multi-line import from `./analytics` at the top of the file, then add:

```ts
it('builds view_item for a print variant with GA4 ecommerce data and Meta ViewContent mapping', () => {
  const event = buildPrintViewItemEvent(
    { id: 'fap01', num: '01', variantLabel: 'A4 · unframed', price: 250 },
    { eventId: 'evt-vi-fap01' },
  );

  expect(event).toMatchObject({
    event: 'view_item',
    event_id: 'evt-vi-fap01',
    ecommerce: {
      currency: ANALYTICS_CURRENCY,
      value: 250,
      items: [
        {
          item_id: 'fap01',
          item_name: 'Print Nº 01',
          item_category: 'fine-art-prints',
          item_variant: 'A4 · unframed',
          price: 250,
          quantity: 1,
        },
      ],
    },
    meta: {
      event_name: 'ViewContent',
      content_ids: ['fap01'],
      event_id: 'evt-vi-fap01',
    },
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/analytics.test.ts -t "view_item for a print"`
Expected: FAIL — `buildPrintViewItemEvent` doesn't exist yet (import error).

- [ ] **Step 3: Implement `buildPrintViewItemEvent`**

Append to `src/lib/analytics.ts`, immediately after `buildViewItemEvent`:

```ts
/**
 * view_item for a fine-art print variant. Mirrors buildPrintAddToCartEvent's
 * shape: item_id = design id, item_variant = the shown size/paper/frame label,
 * price = the resolved variant price (major units).
 */
export function buildPrintViewItemEvent(
  print: { id: string; num: string; variantLabel: string; price: number },
  options: EventOptions = {},
): DataLayerEvent {
  const eventId = options.eventId ?? createEventId('view_item', `${print.id}-${print.variantLabel}`);
  const currency = options.currency ?? ANALYTICS_CURRENCY;
  const item: AnalyticsItem = {
    item_id: print.id,
    item_name: `Print Nº ${print.num}`,
    item_brand: BRAND,
    item_category: 'fine-art-prints',
    item_variant: print.variantLabel,
    price: print.price,
    quantity: 1,
  };
  return withMeta(
    {
      event: 'view_item',
      event_id: eventId,
      ecommerce: ecommerce([item], currency),
    },
    'ViewContent',
    eventId,
  );
}
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run src/lib/analytics.test.ts`
Expected: PASS — all cases.

- [ ] **Step 5: Create `PrintViewAnalytics.tsx`**

```tsx
'use client';

import { useEffect } from 'react';
import { buildPrintViewItemEvent, pushDataLayer } from '@/lib/analytics';
import { useCurrency } from '@/components/currency/CurrencyProvider';
import { currencyFormatter } from '@/lib/format';

type Props = { print: { id: string; num: string; variantLabel: string; price: number } };

/** Fires view_item on the print PDP load, using the default (first) variant — mirrors ProductViewAnalytics. */
export function PrintViewAnalytics({ print }: Props) {
  const currency = useCurrency();
  const { code: analyticsCurrency } = currencyFormatter(currency);

  useEffect(() => {
    pushDataLayer(buildPrintViewItemEvent(print, { currency: analyticsCurrency }));
    // print.id is the stable key; if the page somehow remounts with a different
    // print the event re-fires — intentional for SPA-style navigation, mirrors
    // ProductViewAnalytics.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [print.id]);

  return null;
}
```

- [ ] **Step 6: Mount it in `PrintProductScreen.tsx`**

Replace the import block:

```tsx
import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { currencyFormatter } from '@/lib/format';
import { getCurrency } from '@/lib/currency.server';
import { toChargeableCurrency } from '@/lib/currency';
import { fromPriceOf } from '@/lib/print-pricing';
import { getPrintDesigns } from '@/lib/prints';
import { SITE_NAME } from '@/lib/site';
import { srcSet } from '@/lib/images';
import { ProductPageGallery } from './ProductPageGallery';
import { PrintConfigurator } from './PrintConfigurator';
import type { PrintDesign } from '@/lib/types';
```

with:

```tsx
import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { currencyFormatter } from '@/lib/format';
import { getCurrency } from '@/lib/currency.server';
import { toChargeableCurrency } from '@/lib/currency';
import { fromPriceOf, priceOfVariant } from '@/lib/print-pricing';
import { variantLabel } from '@/lib/print-cart';
import { getPrintDesigns } from '@/lib/prints';
import { SITE_NAME } from '@/lib/site';
import { srcSet } from '@/lib/images';
import { ProductPageGallery } from './ProductPageGallery';
import { PrintConfigurator } from './PrintConfigurator';
import { PrintViewAnalytics } from './PrintViewAnalytics';
import type { PrintDesign } from '@/lib/types';
```

Replace:

```tsx
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const currency = await getCurrency(locale);
  const printCurrency = toChargeableCurrency(currency);
  const { fmt } = currencyFormatter(printCurrency);

  const categoryName = t('nav.fineArtPrints');
```

with:

```tsx
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const currency = await getCurrency(locale);
  const printCurrency = toChargeableCurrency(currency);
  const { fmt } = currencyFormatter(printCurrency);
  const defaultVariant = { size: design.sizes[0], framed: false, mount: false, frameColour: 'none' as const };

  const categoryName = t('nav.fineArtPrints');
```

Replace:

```tsx
            <PrintConfigurator design={design} usableVariantKeys={usableVariantKeys} />
```

with:

```tsx
            <PrintViewAnalytics
              print={{
                id: design.id,
                num: design.num,
                variantLabel: variantLabel(defaultVariant, locale),
                price: priceOfVariant(design, defaultVariant, printCurrency),
              }}
            />
            <PrintConfigurator design={design} usableVariantKeys={usableVariantKeys} />
```

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no new errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/analytics.ts src/lib/analytics.test.ts src/components/shop/PrintViewAnalytics.tsx src/components/shop/PrintProductScreen.tsx
git commit -m "feat(analytics): fire view_item on the print PDP"
```

---

### Task 2: Print collection `view_item_list` (F-07)

**Files:**
- Modify: `src/lib/analytics.ts`
- Test: `src/lib/analytics.test.ts`
- Create: `src/components/shop/PrintCollectionAnalytics.tsx`
- Modify: `src/components/shop/PrintCollectionScreen.tsx`

**Interfaces:**
- Produces: `buildPrintViewItemListEvent(prints: Array<{ id: string; num: string; fromPrice: number }>, details?: { eventId?: string; currency?: CurrencyCode }): DataLayerEvent`.

- [ ] **Step 1: Write the failing test**

In `src/lib/analytics.test.ts`, add `buildPrintViewItemListEvent` to the multi-line import from `./analytics` at the top of the file (alongside whatever Task 1 already added there), then add:

```ts
it('builds view_item_list for the print collection', () => {
  const event = buildPrintViewItemListEvent(
    [
      { id: 'fap01', num: '01', fromPrice: 200 },
      { id: 'fap02', num: '02', fromPrice: 250 },
    ],
    { eventId: 'evt-vil-prints' },
  );

  expect(event).toMatchObject({
    event: 'view_item_list',
    event_id: 'evt-vil-prints',
    ecommerce: {
      currency: ANALYTICS_CURRENCY,
      items: [
        { item_id: 'fap01', item_name: 'Print Nº 01', item_category: 'fine-art-prints', price: 200 },
        { item_id: 'fap02', item_name: 'Print Nº 02', item_category: 'fine-art-prints', price: 250 },
      ],
    },
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/analytics.test.ts -t "view_item_list for the print collection"`
Expected: FAIL — `buildPrintViewItemListEvent` doesn't exist yet.

- [ ] **Step 3: Implement `buildPrintViewItemListEvent`**

Append to `src/lib/analytics.ts`, immediately after `buildViewItemListEvent`:

```ts
/** view_item_list for the fine-art-prints collection. Mirrors buildViewItemListEvent for prints. */
export function buildPrintViewItemListEvent(
  prints: Array<{ id: string; num: string; fromPrice: number }>,
  details: { eventId?: string; currency?: CurrencyCode } = {},
): DataLayerEvent {
  const items: AnalyticsItem[] = prints.map((print) => ({
    item_id: print.id,
    item_name: `Print Nº ${print.num}`,
    item_brand: BRAND,
    item_category: 'fine-art-prints',
    price: print.fromPrice,
    quantity: 1,
  }));
  return {
    event: 'view_item_list',
    event_id: details.eventId ?? createEventId('view_item_list', 'fine-art-prints'),
    ecommerce: ecommerce(items, details.currency),
  };
}
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run src/lib/analytics.test.ts`
Expected: PASS — all cases.

- [ ] **Step 5: Create `PrintCollectionAnalytics.tsx`**

```tsx
'use client';

import { useEffect } from 'react';
import { buildPrintViewItemListEvent, pushDataLayer } from '@/lib/analytics';
import { useCurrency } from '@/components/currency/CurrencyProvider';
import { currencyFormatter } from '@/lib/format';

type Props = { prints: Array<{ id: string; num: string; fromPrice: number }> };

/** Fires view_item_list on the fine-art-prints collection load — mirrors Gallery/GroupedGallery. */
export function PrintCollectionAnalytics({ prints }: Props) {
  const currency = useCurrency();
  const { code: analyticsCurrency } = currencyFormatter(currency);

  useEffect(() => {
    if (prints.length === 0) return;
    pushDataLayer(buildPrintViewItemListEvent(prints, { currency: analyticsCurrency }));
    // Fire once per list; currency captured at first paint, matching Gallery/GroupedGallery.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prints]);

  return null;
}
```

- [ ] **Step 6: Mount it in `PrintCollectionScreen.tsx`**

Replace the import block:

```tsx
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { getPrintDesigns } from '@/lib/prints';
import { fromPriceOf } from '@/lib/print-pricing';
import { currencyFormatter } from '@/lib/format';
import { getCurrency } from '@/lib/currency.server';
import { toChargeableCurrency } from '@/lib/currency';
import { srcSet } from '@/lib/images';
import { richTags } from '@/components/ui/richTags';
import type { Locale } from '@/i18n/routing';
```

with:

```tsx
import { getTranslations } from 'next-intl/server';
import { Link } from '@/i18n/navigation';
import { getPrintDesigns } from '@/lib/prints';
import { fromPriceOf } from '@/lib/print-pricing';
import { currencyFormatter } from '@/lib/format';
import { getCurrency } from '@/lib/currency.server';
import { toChargeableCurrency } from '@/lib/currency';
import { srcSet } from '@/lib/images';
import { richTags } from '@/components/ui/richTags';
import { PrintCollectionAnalytics } from './PrintCollectionAnalytics';
import type { Locale } from '@/i18n/routing';
```

Replace:

```tsx
  return (
    <>
      <section className="shop-head">
```

with:

```tsx
  return (
    <>
      <PrintCollectionAnalytics
        prints={designs.map((d) => ({ id: d.id, num: d.num, fromPrice: fromPriceOf(d, printCurrency) }))}
      />
      <section className="shop-head">
```

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no new errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/analytics.ts src/lib/analytics.test.ts src/components/shop/PrintCollectionAnalytics.tsx src/components/shop/PrintCollectionScreen.tsx
git commit -m "feat(analytics): fire view_item_list on the print collection page"
```

---

### Task 3: Print `remove_from_cart` (F-07)

**Files:**
- Modify: `src/lib/analytics.ts`
- Test: `src/lib/analytics.test.ts`
- Modify: `src/components/shop/CartView.tsx`

**Interfaces:**
- Produces: `buildPrintRemoveFromCartEvent(print: { id: string; num: string; variantLabel: string; price: number }, options?: EventOptions): DataLayerEvent`.

- [ ] **Step 1: Write the failing test**

In `src/lib/analytics.test.ts`, add `buildPrintRemoveFromCartEvent` to the multi-line import from `./analytics` at the top of the file (alongside whatever Tasks 1-2 already added there), then add:

```ts
it('builds remove_from_cart for a print variant (no Meta payload, matching buildRemoveFromCartEvent)', () => {
  const event = buildPrintRemoveFromCartEvent(
    { id: 'fap01', num: '01', variantLabel: 'A4 · unframed', price: 250 },
    { eventId: 'evt-rfc-fap01' },
  );

  expect(event).toMatchObject({
    event: 'remove_from_cart',
    event_id: 'evt-rfc-fap01',
    ecommerce: {
      currency: ANALYTICS_CURRENCY,
      value: 250,
      items: [
        {
          item_id: 'fap01',
          item_name: 'Print Nº 01',
          item_category: 'fine-art-prints',
          item_variant: 'A4 · unframed',
          price: 250,
          quantity: 1,
        },
      ],
    },
  });
  expect(event.meta).toBeUndefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/analytics.test.ts -t "remove_from_cart for a print"`
Expected: FAIL — `buildPrintRemoveFromCartEvent` doesn't exist yet.

- [ ] **Step 3: Implement `buildPrintRemoveFromCartEvent`**

Append to `src/lib/analytics.ts`, immediately after `buildRemoveFromCartEvent`:

```ts
/** remove_from_cart for a fine-art print variant. Mirrors buildPrintAddToCartEvent. */
export function buildPrintRemoveFromCartEvent(
  print: { id: string; num: string; variantLabel: string; price: number },
  options: EventOptions = {},
): DataLayerEvent {
  const eventId = options.eventId ?? createEventId('remove_from_cart', `${print.id}-${print.variantLabel}`);
  const currency = options.currency ?? ANALYTICS_CURRENCY;
  const item: AnalyticsItem = {
    item_id: print.id,
    item_name: `Print Nº ${print.num}`,
    item_brand: BRAND,
    item_category: 'fine-art-prints',
    item_variant: print.variantLabel,
    price: print.price,
    quantity: 1,
  };
  return {
    event: 'remove_from_cart',
    event_id: eventId,
    ecommerce: ecommerce([item], currency),
  };
}
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run src/lib/analytics.test.ts`
Expected: PASS — all cases.

- [ ] **Step 5: Wire it into `CartView.tsx`'s print removal button**

Add `buildPrintRemoveFromCartEvent` to the existing `@/lib/analytics` import (alphabetically, between `buildEngagementEvent` and `buildRemoveFromCartEvent`):

Replace:

```tsx
import {
  analyticsItemsForIds,
  buildEngagementEvent,
  buildRemoveFromCartEvent,
  buildViewCartEventFromItems,
  pushDataLayer,
} from '@/lib/analytics';
```

with:

```tsx
import {
  analyticsItemsForIds,
  buildEngagementEvent,
  buildPrintRemoveFromCartEvent,
  buildRemoveFromCartEvent,
  buildViewCartEventFromItems,
  pushDataLayer,
} from '@/lib/analytics';
```

Replace the print branch's remove button:

```tsx
                  <div className="right">
                    <span className="price">{fmt(priceOfLine(l))}</span>
                    <button className="rm" onClick={() => remove(l.id)}>
                      <Icon name="trash" /> {t('cart.remove')}
                    </button>
                  </div>
```

with:

```tsx
                  <div className="right">
                    <span className="price">{fmt(priceOfLine(l))}</span>
                    <button
                      className="rm"
                      onClick={() => {
                        remove(l.id);
                        pushDataLayer(
                          buildPrintRemoveFromCartEvent({
                            id: d.id,
                            num: d.num,
                            variantLabel: variantLabel(l.sel, locale),
                            price: priceOfLine(l),
                          }),
                        );
                      }}
                    >
                      <Icon name="trash" /> {t('cart.remove')}
                    </button>
                  </div>
```

(This is the print branch specifically — inside `lines.map((l) => { if (l.kind === 'print') { ... } ...`. Do not touch the ceramic branch's remove button a few lines below it, which already fires `buildRemoveFromCartEvent`.)

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/analytics.ts src/lib/analytics.test.ts src/components/shop/CartView.tsx
git commit -m "feat(analytics): fire remove_from_cart when a print is removed from the cart"
```

---

### Task 4: Deduplicate `begin_checkout` per checkout attempt (F-09)

**Files:**
- Modify: `src/lib/checkout-analytics.ts`
- Test: `src/lib/checkout-analytics.test.ts`
- Modify: `src/components/shop/CartView.tsx`

**Interfaces:**
- Produces: `pushCheckoutStartedItemsOnce(attemptId: string, items: AnalyticsItem[], options: CheckoutStartOptions & { storage?: SimpleStorage }): boolean`.
- Consumes: `getDefaultStorage`, `safeGetItem`, `safeSetItem` (the same storage helpers `pushPaymentFailedOnce` already uses), and delegates to the existing `pushCheckoutStartedItems`.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/checkout-analytics.test.ts` (extend the existing import to add `pushCheckoutStartedItemsOnce`):

```ts
it('begin_checkout fires once per attemptId', () => {
  const push = vi.fn();
  const storage = new Map<string, string>();
  const session = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  };
  const items = [
    { item_id: 'k01', item_name: 'Kubek Nº 1', item_brand: 'Anna Ciok Ceramics', item_category: 'kubki', price: 90, quantity: 1 },
  ];

  const first = pushCheckoutStartedItemsOnce('attempt-1', items, {
    shippingCost: 20,
    shippingMethod: 'paczkomat',
    currency: 'PLN',
    push,
    storage: session,
  });
  const second = pushCheckoutStartedItemsOnce('attempt-1', items, {
    shippingCost: 20,
    shippingMethod: 'paczkomat',
    currency: 'PLN',
    push,
    storage: session,
  });

  expect(first).toBe(true);
  expect(second).toBe(false);
  expect(push).toHaveBeenCalledTimes(1);
});

it('begin_checkout fires again for a different attemptId', () => {
  const push = vi.fn();
  const storage = new Map<string, string>();
  const session = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  };
  const items = [
    { item_id: 'k01', item_name: 'Kubek Nº 1', item_brand: 'Anna Ciok Ceramics', item_category: 'kubki', price: 90, quantity: 1 },
  ];

  pushCheckoutStartedItemsOnce('attempt-1', items, {
    shippingCost: 20, shippingMethod: 'paczkomat', currency: 'PLN', push, storage: session,
  });
  const second = pushCheckoutStartedItemsOnce('attempt-2', items, {
    shippingCost: 20, shippingMethod: 'paczkomat', currency: 'PLN', push, storage: session,
  });

  expect(second).toBe(true);
  expect(push).toHaveBeenCalledTimes(2);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/checkout-analytics.test.ts -t "begin_checkout fires"`
Expected: FAIL — `pushCheckoutStartedItemsOnce` doesn't exist yet.

- [ ] **Step 3: Implement `pushCheckoutStartedItemsOnce`**

In `src/lib/checkout-analytics.ts`, add a new dedupe-key prefix alongside the existing ones:

Replace:

```ts
const PURCHASE_DEDUPE_PREFIX = 'acc_purchase_pi:';
const PURCHASE_GAP_DEDUPE_PREFIX = 'acc_purchase_gap_pi:';
const PAYMENT_FAILED_DEDUPE_PREFIX = 'acc_payment_failed_pi:';
const CHECKOUT_SNAPSHOT_KEY = 'acc_checkout_snapshot';
```

with:

```ts
const PURCHASE_DEDUPE_PREFIX = 'acc_purchase_pi:';
const PURCHASE_GAP_DEDUPE_PREFIX = 'acc_purchase_gap_pi:';
const PAYMENT_FAILED_DEDUPE_PREFIX = 'acc_payment_failed_pi:';
const BEGIN_CHECKOUT_DEDUPE_PREFIX = 'acc_begin_checkout_attempt:';
const CHECKOUT_SNAPSHOT_KEY = 'acc_checkout_snapshot';
```

Add a new function immediately after `pushCheckoutStartedItems`:

```ts
/**
 * begin_checkout, deduplicated per checkout attempt. CartView regenerates
 * attemptId only on a received failure or a cart-contents change (see
 * resetAttemptId's call sites) — so a same-attempt retry (e.g. the
 * checkout_in_progress 409, where attemptId is deliberately KEPT so the retry
 * replays onto the same reservation) no longer fires a second begin_checkout.
 * Mirrors pushPaymentFailedOnce's per-key sessionStorage guard.
 */
export function pushCheckoutStartedItemsOnce(
  attemptId: string,
  items: AnalyticsItem[],
  options: CheckoutStartOptions & { storage?: SimpleStorage },
): boolean {
  const storage = options.storage ?? getDefaultStorage();
  const key = `${BEGIN_CHECKOUT_DEDUPE_PREFIX}${attemptId}`;
  if (safeGetItem(storage, key) === '1') return false;

  pushCheckoutStartedItems(items, options);
  safeSetItem(storage, key, '1');
  return true;
}
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `npx vitest run src/lib/checkout-analytics.test.ts`
Expected: PASS — all cases.

- [ ] **Step 5: Wire it into `CartView.tsx`'s `handleCheckout`**

Add `pushCheckoutStartedItemsOnce` to the existing `@/lib/checkout-analytics` import:

Replace:

```tsx
import {
  forgetRememberedCheckout,
  pushCheckoutStartedItems,
  rememberCheckoutForReturn,
} from '@/lib/checkout-analytics';
```

with:

```tsx
import {
  forgetRememberedCheckout,
  pushCheckoutStartedItemsOnce,
  rememberCheckoutForReturn,
} from '@/lib/checkout-analytics';
```

Replace:

```tsx
    // begin_checkout itemises the whole cart (ceramics + prints); print items are
    // resolved from their tokens with server-equal prices.
    const checkoutItems = analyticsItemsForIds(lines.map((l) => l.id), lines.map(priceOfLine));
    pushCheckoutStartedItems(checkoutItems, {
      shippingCost: shipCost,
      shippingMethod: ship,
      userData: em ? { em } : undefined,
      currency: analyticsCurrency,
    });
```

with:

```tsx
    // begin_checkout itemises the whole cart (ceramics + prints); print items are
    // resolved from their tokens with server-equal prices. Deduplicated per
    // attemptId so a retry that keeps the same attemptId (e.g. a
    // checkout_in_progress 409) doesn't inflate the count.
    const checkoutItems = analyticsItemsForIds(lines.map((l) => l.id), lines.map(priceOfLine));
    pushCheckoutStartedItemsOnce(attemptId, checkoutItems, {
      shippingCost: shipCost,
      shippingMethod: ship,
      userData: em ? { em } : undefined,
      currency: analyticsCurrency,
    });
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no new errors. (If `pushCheckoutStartedItems` — the non-deduped version — has no other call sites left in `CartView.tsx` after this change, leave its export in `checkout-analytics.ts` as-is; it is still used directly by `checkout-analytics.test.ts` and is a reasonable building block for `pushCheckoutStartedItemsOnce` to delegate to.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/checkout-analytics.ts src/lib/checkout-analytics.test.ts src/components/shop/CartView.tsx
git commit -m "fix(analytics): deduplicate begin_checkout per checkout attempt"
```

---

### Task 5: Manually verify the new print-funnel events via GTM Preview

**This task requires a browser and GTM Preview access** — it verifies the component wiring from Tasks 1-3, which (per Global Constraints) cannot be unit-tested in this repo's current Vitest setup.

- [ ] **Step 1: Start the dev server with GTM configured**

Run: `npm run dev` (ensure `NEXT_PUBLIC_GTM_ID` is set in `.env.local`, per `docs/analytics-stack.md`'s existing Verification Checklist).

- [ ] **Step 2: Open GTM Preview for the same container**

In the GTM UI, click Preview, enter the local dev URL.

- [ ] **Step 3: Verify `view_item_list`**

Visit `/fine-art-prints`. In the Preview timeline, confirm a `view_item_list` event fired with `ecommerce.items` containing every published print design, `item_category: 'fine-art-prints'`.

- [ ] **Step 4: Verify `view_item`**

Click into any print's PDP. Confirm a `view_item` event fired with `ecommerce.items[0].item_variant` matching the print's default (first) size, unframed.

- [ ] **Step 5: Verify `remove_from_cart`**

Add the print to cart (any variant), go to `/koszyk`, click Remove on the print's cart line. Confirm a `remove_from_cart` event fired with `ecommerce.items[0].item_id` matching the print's design id. Before this plan, removing a print fired nothing.

- [ ] **Step 6: Record the result**

Note the outcome (pass/fail, with a screenshot of the Preview timeline if convenient) in the PR description. No commit for this task — it is verification only.

---

## Self-Review Notes

- **Coverage:** F-07 (print `view_item`, `view_item_list`, `remove_from_cart`) → Tasks 1-3. F-09 (`begin_checkout` inflation on retry) → Task 4. Manual confirmation of the component wiring (untestable via the current unit-test setup) → Task 5.
- **Placeholder scan:** no TBD/TODO; every step shows exact before/after code and exact commands.
- **Type consistency:** the `{ id, num, variantLabel, price }` shape used for `buildPrintViewItemEvent`/`buildPrintRemoveFromCartEvent` matches `buildPrintAddToCartEvent`'s existing parameter shape exactly (`PrintConfigurator.tsx` already builds this exact object today for `buildPrintAddToCartEvent`), so no new type needs to be introduced or exported — call sites can reuse the same object construction pattern already proven in `PrintConfigurator.tsx`.
- **Explicitly out of scope (tracked in the audit but not this plan):** `select_item` for print tiles (F-07's full finding text mentions it, but the audit's own remediation table — section H, row 2.3 — does not list it, and it requires converting a static `<Link>` tile into a client component, a bigger structural change than this plan's other items).
