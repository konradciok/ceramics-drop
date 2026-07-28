# Fine-Art Prints — Analytics Parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make fine-art prints a first-class analytics citizen — in the merchant feeds with matching catalog ids, and with the full view/list/select/remove funnel like ceramics.

**Architecture:** Prints already have a typed builder (`buildPrintAddToCartEvent`) and a cart-token resolver (`analyticsItemForId`) in `src/lib/analytics.ts`; this plan extends that same layer with print `view_item` / `view_item_list` / `select_item` / `remove_from_cart` builders (sharing one `printAnalyticsItem()` item-shape helper), and appends the published designs from `src/lib/prints.ts` to the two XML merchant feeds so the emitted `fap0x` `content_ids` resolve to real feed rows. Two thin client islands — `PrintViewAnalytics` on the PDP and `PrintCollectionAnalytics` wrapping the server-rendered tile grid — fire the funnel events, and the cart/configurator remove paths call the new remove builder. No new dependencies, no DB/schema changes.

**Tech Stack:** Next.js 16 App Router, TypeScript, Vitest, GTM/GA4/Meta, Cloudflare Workers.

## Global Constraints
- Build MUST stay `next build --webpack` — never Turbopack.
- All analytics events go through `pushDataLayer()` in `src/lib/analytics.ts`; never call `gtag()`/`fbq()` directly in `src/`.
- Analytics uses MAJOR currency units; display currency comes from `useCurrency()` (client), not the locale.
- Meta `content_ids` / GA4 `item_id` / feed `g:id` MUST be the same id space per product (ceramic `k01`, print `fap01`).
- Default to server components; add `'use client'` only for state/effects. Import `Link` from `src/i18n/navigation.ts`.
- Unit tests: `npx vitest run <file>`. E2E: `npx playwright test <spec>`.

---

## Background — what N-2 / F-07 actually is

From `docs/audits/analytics-architecture-audit-2026-07-28.md` §6 (High, N-2; subsumes prior F-07):

- **N-2(a) — feed blind spot.** Both feeds iterate ceramics only (`buildFeedItemsWithNotes` maps `getPublicProducts()`, `src/lib/feed.ts:115`); `fine-art-prints` is deliberately excluded (`feed.ts:51,64,88`, `// ponytail: excluded from feed`). But print Meta/GA4 events emit `content_ids` / `item_id` = the **design id** `fap0x` (`withMeta` at `analytics.ts:499` maps `item.item_id`; the print item's `item_id` = `design.id`, set in `buildPrintAddToCartEvent` `analytics.ts:176-184` and `analyticsItemForId` `analytics.ts:125-133`). No feed row carries those ids → catalog attribution + dynamic remarketing for the whole print line are structurally broken.
- **N-2(b) — funnel gap.** Print PDP fires no `view_item`/`ViewContent` (`PrintProductScreen.tsx` mounts only `PrintConfigurator`, vs ceramic `ProductPageScreen.tsx:54` mounting `ProductViewAnalytics` whose effect calls `buildViewItemEvent` at `ProductViewAnalytics.tsx:18`). Print collection fires no `view_item_list`/`select_item` (`PrintCollectionScreen.tsx` renders server-only `<Link>` tiles, vs ceramic `Gallery.tsx:54` view_item_list / `:93` select_item). Print removal fires nothing (`CartView.tsx:575`, `PrintConfigurator.tsx:191`) vs ceramic `CartView.tsx:601`.

**Decided approach (do not redesign):** add published prints to both feeds with `g:id = fap0x` (prints are actively sold — the audit's recommended branch), and add the four missing print funnel builders + the two islands + the two remove call-sites. Ceramic `remove_from_cart` is GA4-only (`buildRemoveFromCartEvent` `analytics.ts:196` returns no `meta`); the print remove/list/select builders mirror that (no `meta`), while print `view_item` mirrors ceramic `buildViewItemEvent` and DOES attach Meta `ViewContent`.

## File Structure

**Modified**
- `src/lib/feed.ts` — new `buildPrintFeedItems(locale)`; append its rows in `buildFeedItems` + `buildFeedItemsCms`; drop the 3 stale `// ponytail: excluded from feed` comments.
- `src/lib/analytics.ts` — `printAnalyticsItem()` helper; refactor `buildPrintAddToCartEvent` onto it; add `buildPrintViewItemEvent`, `buildPrintViewItemListEvent`, `buildPrintSelectItemEvent`, `buildPrintRemoveFromCartEvent`.
- `src/components/shop/PrintProductScreen.tsx` — mount `PrintViewAnalytics`.
- `src/components/shop/PrintCollectionScreen.tsx` — compute per-design analytics items + wrap the tile grid in `PrintCollectionAnalytics`.
- `src/components/shop/PrintConfigurator.tsx` — fire `remove_from_cart` on the in-cart remove branch.
- `src/components/shop/CartView.tsx` — fire `remove_from_cart` on the print cart-line remove button.
- `src/lib/feed.test.ts` — print feed rows + `content_ids ⊆ feed ids` invariant.
- `src/lib/analytics.test.ts` — the four new print builders.
- `e2e/print-configurator.spec.ts` — append a full-funnel `@ci` test (list → select → view → add → remove) asserting each event via the debug buffer.

**Created**
- `src/components/shop/PrintViewAnalytics.tsx` — client island, `view_item` on print PDP load.
- `src/components/shop/PrintCollectionAnalytics.tsx` — client wrapper, `view_item_list` on mount + `select_item` on tile click.

---

## Task 1 — Prints in the Meta + Google feeds (N-2a)

**Acceptance:** every id emitted by print Meta events (`fap01`/`fap02`/`fap03`) has a matching `g:id` row in both feeds, one row per published design per FEED_LOCALE, priced from `print-pricing.ts` in the locale's feed currency (PLN for `pl`, EUR otherwise), always `in stock` (POD), shipping to the locale's country via `printShippingOf`.

### 1a. Write the feed tests first (TDD)

- [ ] Append to `src/lib/feed.test.ts` (imports at top become `import { buildFeedItems, buildGoogleXml, buildMetaXml, type FeedItem } from './feed';` **plus** `import { getPrintDesigns } from './prints';`):

```ts
describe('fine-art-print feed rows', () => {
  it('includes one row per published print design, matching the emitted content_ids', async () => {
    const items = await buildFeedItems('en', new Set());
    const feedIds = new Set(items.map((i) => i.id));
    const designIds = (await getPrintDesigns()).map((d) => d.id);
    expect(designIds).toContain('fap01'); // guard: registry actually has published prints
    for (const id of designIds) expect(feedIds.has(id)).toBe(true);
  });

  it('prices prints from print-pricing "from" price in the locale currency, always in stock', async () => {
    const pl = (await buildFeedItems('pl', new Set())).find((i) => i.id === 'fap01');
    const en = (await buildFeedItems('en', new Set())).find((i) => i.id === 'fap01');
    // fap01 cheapest size (30x40) = 105 PLN / 25 EUR (print-pricing SIZE_BASE).
    expect(pl?.price).toBe('105.00 PLN');
    expect(en?.price).toBe('25.00 EUR');
    expect(pl?.category).toBe('fine-art-prints');
    expect(pl?.availability).toBe('in stock'); // print-on-demand — never sold out
    expect(pl?.shipping.length).toBeGreaterThan(0);
  });

  it('renders a print g:id into both feed XMLs', async () => {
    const items = await buildFeedItems('en', new Set());
    expect(buildMetaXml(items, 'en')).toContain('<g:id>fap01</g:id>');
    expect(buildGoogleXml(items, 'en')).toContain('<g:id>fap01</g:id>');
  });
});
```

- [ ] Run — expect the three new tests to FAIL (no print rows yet), existing tests still green:

```bash
npx vitest run src/lib/feed.test.ts
```
Expected: `Tests  3 failed | <existing> passed` — the print `find(...)` returns `undefined`.

### 1b. Implement `buildPrintFeedItems` and wire it in

- [ ] In `src/lib/feed.ts`, extend the imports (lines 1-3) to pull in the print registry + pricing + shipping type:

```ts
import { getPublicProducts, CATEGORIES } from './products';
import { getPrintDesigns } from './prints';
import { priceOf, SHIPPING_PLN, SHIPPING_EUR } from './pricing';
import { fromPriceOf } from './print-pricing';
import { printShippingOf, type PrintCountry } from './print-shipping';
import type { PrintVariantSelection } from './types';
```

- [ ] Update the three stale trailing comments so they no longer claim prints are excluded (they are now used by the feed): change `feed.ts:51`, `:64`, `:88` from `// ponytail: excluded from feed…` to `// fine-art prints — merchant feed row (see buildPrintFeedItems)`.

- [ ] Add `buildPrintFeedItems` next to `buildFeedItemsWithNotes` (after the ceramic builder, before `itemToGoogleXml`). Prints ship to a home address only (never a locker), so the shipping line is a single Prodigi rate to the locale's country; `SHIPPING_COUNTRY` values (`PL`/`IE`/`ES`/`DE`) are all members of `PRINT_COUNTRIES`. The unframed "from" price pairs with the loose (unframed) shipping rate:

```ts
/**
 * Merchant-feed rows for published fine-art prints. One row per design per
 * locale, id = design id (fap0x) so it matches the fap0x content_ids/item_ids
 * the print pixel + CAPI emit (see buildPrintAddToCartEvent). Prints are
 * print-on-demand: always in stock, priced from the cheapest sellable variant,
 * shipped to a home address (Prodigi) — never a locker.
 */
async function buildPrintFeedItems(locale: FeedLocale): Promise<FeedItem[]> {
  const msg = LOCALE_MESSAGES[locale];
  const cur = currency(locale); // 'PLN' | 'EUR'
  const chargeable = locale === 'pl' ? 'pln' : 'eur'; // feeds never quote GBP
  const singular = (msg.product as Record<string, string>).print ?? 'Print';
  const country = SHIPPING_COUNTRY[locale] as PrintCountry;
  const designs = await getPrintDesigns(); // published only, CATALOG_SOURCE-aware

  return designs.map((design) => {
    const title = `${singular} #${design.num}`;
    const notes = (msg.notes as Record<string, string[]>)['fine-art-prints'];
    const description = notes?.[design.noteIndex] ?? title;

    const link = absoluteUrl(locale, `/fine-art-prints/${design.id}`);
    const imageLink = `${SITE_URL}${design.image}`;
    const additionalImages = (design.gallery ?? []).map((g) => `${SITE_URL}${g}`);

    const price = fromPriceOf(design, chargeable);
    // Loose (unframed) rate pairs with the unframed "from" price above.
    const shipCost = printShippingOf(country, false, chargeable);

    return {
      id: design.id,
      title,
      description,
      link,
      imageLink,
      additionalImages,
      availability: 'in stock',
      price: `${price}.00 ${cur}`,
      category: 'fine-art-prints',
      material: 'Fine Art Print',
      productType: `Prints > ${singular}`,
      customLabel0: PRICE_TIER['fine-art-prints'],
      customLabel1: PRODUCT_FAMILY['fine-art-prints'],
      customLabel2: 'fine-art-prints',
      shipping: [{ country, service: 'Prodigi', price: `${shipCost}.00 ${cur}` }],
    };
  });
}
```

Note: `PrintVariantSelection` is imported for Task 3/4 parity but not needed here — drop it from this file's import if unused after Task 1 (it is only used inside components). Keep the feed import list to what `feed.ts` actually references: `getPrintDesigns`, `fromPriceOf`, `printShippingOf`, `PrintCountry`.

- [ ] Append prints in both public builders (`feed.ts:165` and `:169`):

```ts
export async function buildFeedItems(locale: FeedLocale, soldIds: Set<string>, showroomIds: Set<string> = new Set()): Promise<FeedItem[]> {
  const ceramics = await buildFeedItemsWithNotes(locale, soldIds, showroomIds);
  return [...ceramics, ...(await buildPrintFeedItems(locale))];
}

export async function buildFeedItemsCms(locale: FeedLocale, soldIds: Set<string>, showroomIds: Set<string> = new Set()): Promise<FeedItem[]> {
  const products = await getPublicProducts();
  const slugs = [...new Set(products.map((product) => product.category))];
  const entries = await Promise.all(slugs.map(async (slug) => [slug, await getProductNotes(slug, locale)] as const));
  const ceramics = await buildFeedItemsWithNotes(locale, soldIds, showroomIds, Object.fromEntries(entries) as Partial<Record<CategorySlug, Record<string, string>>>, products);
  return [...ceramics, ...(await buildPrintFeedItems(locale))];
}
```

Print notes come from the static i18n messages (`notes.fine-art-prints`, verified present with 3 entries in all of `pl`/`en`/`es`/`de`), not the CMS — prints have no CMS note pipeline in the feed, and this keeps the diff to the ceramic-only `notesBySlug` path untouched. `// ponytail: print feed descriptions use static i18n notes; wire CMS print notes only if editors start drafting them.`

- [ ] The XML serializers need no change: `itemToGoogleXml`/`itemToMetaXml` are generic over `FeedItem`, and `GOOGLE_CATEGORY['fine-art-prints']`, `PRICE_TIER['fine-art-prints']`, `PRODUCT_FAMILY['fine-art-prints']` already exist.

- [ ] Run the feed tests + typecheck:

```bash
npx vitest run src/lib/feed.test.ts && npm run typecheck
```
Expected: `Test Files  1 passed (1)` with the 3 new tests green and all pre-existing feed tests still passing; `tsc --noEmit` exits 0.

- [ ] Commit: `fix(feed): add published fine-art prints to Google + Meta feeds (N-2a)`.

---

## Task 2 — Print funnel builders in `analytics.ts` (N-2b)

**Acceptance:** four new exported builders produce the correct GA4 event shape and Meta parity — `view_item` carries Meta `ViewContent`; `view_item_list`/`select_item`/`remove_from_cart` are GA4-only (no `meta`, matching ceramics). Every builder's `content_ids`/`item_id` is the design id `fap0x` (feed-parity anchor). All prints route through one `printAnalyticsItem()` shape helper.

### 2a. Write the analytics tests first (TDD)

- [ ] Add to `src/lib/analytics.test.ts` — extend the import list from `./analytics` with the four builders, then append a describe block:

```ts
import {
  ANALYTICS_CURRENCY,
  buildAddToCartEvent,
  buildBeginCheckoutEvent,
  buildEngagementEvent,
  buildPageViewEvent,
  buildPrintAddToCartEvent,
  buildPrintRemoveFromCartEvent,
  buildPrintSelectItemEvent,
  buildPrintViewItemEvent,
  buildPrintViewItemListEvent,
  buildPurchaseEvent,
  pushDataLayer,
  redactSensitiveUrl,
  toAnalyticsItem,
} from './analytics';
```

```ts
describe('fine-art-print funnel builders', () => {
  const fap = { id: 'fap01', num: '01', variantLabel: '30×40 cm · no frame', price: 25 };

  it('view_item carries GA4 item + Meta ViewContent, item_id = design id', () => {
    const e = buildPrintViewItemEvent(fap, { currency: 'EUR', eventId: 'evt-vi' });
    expect(e).toMatchObject({
      event: 'view_item',
      event_id: 'evt-vi',
      ecommerce: {
        currency: 'EUR',
        value: 25,
        items: [{
          item_id: 'fap01',
          item_name: 'Print Nº 01',
          item_category: 'fine-art-prints',
          item_variant: '30×40 cm · no frame',
          price: 25,
          quantity: 1,
        }],
      },
      meta: { event_name: 'ViewContent', content_ids: ['fap01'], value: 25, event_id: 'evt-vi' },
    });
  });

  it('view_item_list indexes items and is GA4-only (no meta)', () => {
    const e = buildPrintViewItemListEvent(
      [fap, { id: 'fap02', num: '02', variantLabel: '30×40 cm · no frame', price: 25 }],
      { itemListId: 'fine-art-prints', itemListName: 'fine-art-prints', currency: 'EUR', eventId: 'evt-vil' },
    );
    expect(e.event).toBe('view_item_list');
    expect(e.meta).toBeUndefined();
    expect(e.ecommerce?.items).toMatchObject([
      { item_id: 'fap01', index: 0, item_list_id: 'fine-art-prints' },
      { item_id: 'fap02', index: 1, item_list_id: 'fine-art-prints' },
    ]);
  });

  it('select_item carries list context and is GA4-only', () => {
    const e = buildPrintSelectItemEvent(fap, { index: 3, itemListId: 'fine-art-prints', itemListName: 'fine-art-prints', currency: 'EUR' });
    expect(e.event).toBe('select_item');
    expect(e.meta).toBeUndefined();
    expect(e.ecommerce?.items[0]).toMatchObject({ item_id: 'fap01', index: 3, item_list_id: 'fine-art-prints' });
  });

  it('remove_from_cart is GA4-only, mirroring the ceramic remove', () => {
    const e = buildPrintRemoveFromCartEvent(fap, { currency: 'EUR' });
    expect(e.event).toBe('remove_from_cart');
    expect(e.meta).toBeUndefined();
    expect(e.ecommerce?.items[0].item_id).toBe('fap01');
  });

  it('add + view content_ids agree on the design id (feed-parity anchor)', () => {
    const add = buildPrintAddToCartEvent(fap, { currency: 'EUR' });
    const view = buildPrintViewItemEvent(fap, { currency: 'EUR' });
    expect(add.meta?.content_ids).toEqual(['fap01']);
    expect(view.meta?.content_ids).toEqual(['fap01']);
  });
});
```

- [ ] Run — expect FAIL (builders don't exist / won't import):

```bash
npx vitest run src/lib/analytics.test.ts
```
Expected: import/reference errors for the four new builders.

### 2b. Implement the helper + builders

- [ ] In `src/lib/analytics.ts`, add a shared item-shape helper and refactor `buildPrintAddToCartEvent` (currently `:170-194`) onto it, then add the four builders. Place the helper directly above `buildPrintAddToCartEvent`:

```ts
type PrintItemInput = { id: string; num: string; variantLabel: string; price: number };

/** One canonical AnalyticsItem shape for a print variant (item_id = design id,
 *  so Meta content_ids / GA4 item_id match the fap0x merchant-feed rows). */
function printAnalyticsItem(print: PrintItemInput): AnalyticsItem {
  return {
    item_id: print.id,
    item_name: `Print Nº ${print.num}`,
    item_brand: BRAND,
    item_category: 'fine-art-prints',
    item_variant: print.variantLabel,
    price: print.price,
    quantity: 1,
  };
}
```

```ts
/**
 * add_to_cart for a fine-art print variant. Prints aren't `Product`s, so this
 * builds the AnalyticsItem via printAnalyticsItem: item_id = design id,
 * item_variant = the chosen size/frame label, price = resolved variant price.
 */
export function buildPrintAddToCartEvent(
  print: PrintItemInput,
  options: EventOptions = {},
): DataLayerEvent {
  const eventId = options.eventId ?? createEventId('add_to_cart', `${print.id}-${print.variantLabel}`);
  const currency = options.currency ?? ANALYTICS_CURRENCY;
  return withMeta(
    {
      event: 'add_to_cart',
      event_id: eventId,
      ecommerce: ecommerce([printAnalyticsItem(print)], currency),
    },
    'AddToCart',
    eventId,
  );
}

/** view_item for a print PDP — mirrors buildViewItemEvent (GA4 + Meta ViewContent). */
export function buildPrintViewItemEvent(
  print: PrintItemInput,
  options: EventOptions = {},
): DataLayerEvent {
  const eventId = options.eventId ?? createEventId('view_item', `${print.id}-${print.variantLabel}`);
  const currency = options.currency ?? ANALYTICS_CURRENCY;
  return withMeta(
    {
      event: 'view_item',
      event_id: eventId,
      ecommerce: ecommerce([printAnalyticsItem(print)], currency),
    },
    'ViewContent',
    eventId,
  );
}

/** view_item_list for the print collection — GA4-only, mirrors buildViewItemListEvent. */
export function buildPrintViewItemListEvent(
  prints: PrintItemInput[],
  details: { itemListId: string; itemListName: string; eventId?: string; currency?: CurrencyCode },
): DataLayerEvent {
  const items = prints.map((print, index) => ({
    ...printAnalyticsItem(print),
    index,
    item_list_id: details.itemListId,
    item_list_name: details.itemListName,
  }));
  return {
    event: 'view_item_list',
    event_id: details.eventId ?? createEventId('view_item_list', details.itemListId),
    ecommerce: ecommerce(items, details.currency),
  };
}

/** select_item for a print tile — GA4-only, mirrors buildSelectItemEvent. */
export function buildPrintSelectItemEvent(
  print: PrintItemInput,
  details: { index?: number; itemListId?: string; itemListName?: string; eventId?: string; currency?: CurrencyCode } = {},
): DataLayerEvent {
  const item: AnalyticsItem = {
    ...printAnalyticsItem(print),
    ...(details.index !== undefined ? { index: details.index } : {}),
    ...(details.itemListId ? { item_list_id: details.itemListId } : {}),
    ...(details.itemListName ? { item_list_name: details.itemListName } : {}),
  };
  return {
    event: 'select_item',
    event_id: details.eventId ?? createEventId('select_item', print.id),
    ecommerce: ecommerce([item], details.currency),
  };
}

/** remove_from_cart for a print variant — GA4-only, mirrors buildRemoveFromCartEvent. */
export function buildPrintRemoveFromCartEvent(
  print: PrintItemInput,
  options: EventOptions = {},
): DataLayerEvent {
  const eventId = options.eventId ?? createEventId('remove_from_cart', `${print.id}-${print.variantLabel}`);
  const currency = options.currency ?? ANALYTICS_CURRENCY;
  return {
    event: 'remove_from_cart',
    event_id: eventId,
    ecommerce: ecommerce([printAnalyticsItem(print)], currency),
  };
}
```

`EventOptions`, `AnalyticsItem`, `CurrencyCode`, `BRAND`, `ecommerce`, `withMeta`, `createEventId`, `ANALYTICS_CURRENCY` are all already defined in this file — no new imports.

- [ ] Run the analytics tests + typecheck:

```bash
npx vitest run src/lib/analytics.test.ts && npm run typecheck
```
Expected: `Test Files  1 passed (1)` with the 5 new `fine-art-print funnel builders` tests green (pre-existing tests, incl. the `buildPrintAddToCartEvent` refactor target, unchanged); `tsc --noEmit` exits 0.

- [ ] Commit: `feat(analytics): add print view/list/select/remove builders (N-2b)`.

---

## Task 3 — `view_item` on the print PDP (N-2b)

**Acceptance:** loading a published print PDP pushes one `view_item` (Meta `ViewContent`) with `item_id = fap0x`, `item_variant` = the configurator's entry selection (first size, unframed), price in the display currency (major units).

- [ ] Create `src/components/shop/PrintViewAnalytics.tsx` (mirror of `ProductViewAnalytics.tsx`; the entry selection matches `PrintConfigurator`'s initial `useState` — first size, unframed):

```tsx
'use client';

import { useEffect } from 'react';
import { useLocale } from 'next-intl';
import { buildPrintViewItemEvent, pushDataLayer } from '@/lib/analytics';
import { useCurrency } from '@/components/currency/CurrencyProvider';
import { toChargeableCurrency } from '@/lib/currency';
import { currencyFormatter } from '@/lib/format';
import { priceOfVariant } from '@/lib/print-pricing';
import { variantLabel } from '@/lib/print-cart';
import type { PrintDesign, PrintVariantSelection } from '@/lib/types';

type Props = { design: PrintDesign };

/** Fires view_item on print PDP load — mirrors ProductViewAnalytics for ceramics.
 *  Uses the configurator's entry selection (first size, unframed) so item_variant
 *  and price match what the buyer first sees. */
export function PrintViewAnalytics({ design }: Props) {
  const currency = useCurrency();
  const locale = useLocale();
  const printCurrency = toChargeableCurrency(currency);
  const { code: analyticsCurrency } = currencyFormatter(printCurrency);

  useEffect(() => {
    const sel: PrintVariantSelection = { size: design.sizes[0], framed: false, mount: false, frameColour: 'none' };
    pushDataLayer(
      buildPrintViewItemEvent(
        { id: design.id, num: design.num, variantLabel: variantLabel(sel, locale), price: priceOfVariant(design, sel, printCurrency) },
        { currency: analyticsCurrency },
      ),
    );
    // design.id is the stable key; a remount with a different design re-fires —
    // intentional for SPA-style navigation, exactly like ProductViewAnalytics.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [design.id]);

  return null;
}
```

- [ ] Mount it in `src/components/shop/PrintProductScreen.tsx`. Add the import and wrap the returned `<article>` in a fragment with the island first (mirrors `ProductPageScreen.tsx:49-54`):

```tsx
import { PrintViewAnalytics } from './PrintViewAnalytics';
```
```tsx
  return (
    <>
      <PrintViewAnalytics design={design} />
      <article className="pdp">
        {/* …unchanged… */}
      </article>
    </>
  );
```

- [ ] `PrintProductScreen` stays a server component; the client island is a leaf (like `PrintConfigurator`). Verify:

```bash
npm run typecheck && npm run lint
```
Expected: both exit 0.

- [ ] Mount/render note (no jsdom harness in-repo, matching the `PrintConfigurator` comment): manual/E2E check in Task 6.

- [ ] Commit: `feat(analytics): fire view_item on print PDP (N-2b)`.

---

## Task 4 — `view_item_list` + `select_item` on the print collection (N-2b)

**Acceptance:** the `/fine-art-prints` grid pushes one `view_item_list` on mount (all published designs, indexed) and a `select_item` when a tile is clicked (matched by `data-product-id`, carrying its list index) — all in the display currency. Tiles stay server-rendered `<Link>`s (SEO/prefetch preserved).

- [ ] Create `src/components/shop/PrintCollectionAnalytics.tsx` — a thin client wrapper that renders the existing `.gallery` container (so the tile markup and `data-product-id` come from the server screen unchanged) and adds the two events. The tiles already carry `data-product-id={d.id}` and `data-testid="print-tile"` (`PrintCollectionScreen.tsx:49-51`):

```tsx
'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { buildPrintSelectItemEvent, buildPrintViewItemListEvent, pushDataLayer } from '@/lib/analytics';
import type { CurrencyCode } from '@/lib/format';

export type PrintListItem = { id: string; num: string; variantLabel: string; price: number };

/** Client wrapper for the server-rendered print tile grid: view_item_list once
 *  on mount, select_item on tile click. Tiles stay server <Link>s; this only
 *  adds analytics via the container + data-product-id (event delegation). */
export function PrintCollectionAnalytics({
  items,
  listId,
  listName,
  currency,
  children,
}: {
  items: PrintListItem[];
  listId: string;
  listName: string;
  currency: CurrencyCode;
  children: ReactNode;
}) {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current || items.length === 0) return;
    fired.current = true;
    pushDataLayer(buildPrintViewItemListEvent(items, { itemListId: listId, itemListName: listName, currency }));
  }, [items, listId, listName, currency]);

  return (
    <div
      className="gallery"
      data-count={items.length}
      onClick={(e) => {
        const tile = (e.target as HTMLElement).closest('[data-product-id]');
        const id = tile?.getAttribute('data-product-id');
        if (!id) return;
        const index = items.findIndex((i) => i.id === id);
        const item = items[index];
        if (!item) return;
        pushDataLayer(buildPrintSelectItemEvent(item, { index, itemListId: listId, itemListName: listName, currency }));
      }}
    >
      {children}
    </div>
  );
}
```

- [ ] Update `src/components/shop/PrintCollectionScreen.tsx`: import the wrapper + `variantLabel` + the selection type, expose the analytics currency `code`, compute one `PrintListItem` per design (entry variant → `from` price, matching the tile's displayed "from X"), and replace the raw `<div className="gallery">` with the wrapper (tiles unchanged as its children):

```tsx
import { PrintCollectionAnalytics, type PrintListItem } from './PrintCollectionAnalytics';
import { variantLabel } from '@/lib/print-cart';
import type { Locale } from '@/i18n/routing';
import type { PrintVariantSelection } from '@/lib/types';
```
```tsx
  const { fmt, code: analyticsCurrency } = currencyFormatter(printCurrency);

  const analyticsItems: PrintListItem[] = designs.map((d) => {
    const sel: PrintVariantSelection = { size: d.sizes[0], framed: false, mount: false, frameColour: 'none' };
    return { id: d.id, num: d.num, variantLabel: variantLabel(sel, locale), price: fromPriceOf(d, printCurrency) };
  });
```
Then swap the grid wrapper:
```tsx
      <PrintCollectionAnalytics items={analyticsItems} listId={SLUG} listName={SLUG} currency={analyticsCurrency}>
        {designs.map((d) => {
          const from = fmt(fromPriceOf(d, printCurrency));
          const name = `${t('product.print')} Nº ${d.num}`;
          return (
            <Link
              key={d.id}
              href={`/${SLUG}/${d.id}`}
              className="tile tile-print"
              data-product-id={d.id}
              data-testid="print-tile"
              aria-label={name}
            >
              {/* …existing <img> + tile-meta unchanged… */}
            </Link>
          );
        })}
      </PrintCollectionAnalytics>
```
(The `<div className="gallery" data-count={designs.length}>…</div>` wrapper is removed — the client component renders that same `div` now.)

- [ ] Verify:

```bash
npm run typecheck && npm run lint
```
Expected: both exit 0.

- [ ] Commit: `feat(analytics): fire view_item_list + select_item on print collection (N-2b)`.

---

## Task 5 — `remove_from_cart` for prints (N-2b)

**Acceptance:** removing a print — from the cart line **and** from the PDP configurator's in-cart toggle — pushes a `remove_from_cart` (GA4-only) with `item_id = fap0x`, the variant label, and the variant price in the display currency.

- [ ] `src/components/shop/CartView.tsx`: add `buildPrintRemoveFromCartEvent` to the `@/lib/analytics` import (joining `analyticsItemsForIds`, `buildEngagementEvent`, `buildRemoveFromCartEvent`, `buildViewCartEventFromItems`, `pushDataLayer`), then fire it on the print-line remove button (`CartView.tsx:575`; `l` is a print `CartLine`, so `l.design`/`l.sel` exist; `variantLabel`, `analyticsCurrency`, `locale`, `priceOfLine` are all already in scope):

```tsx
                    <button className="rm" onClick={() => {
                      remove(l.id);
                      pushDataLayer(
                        buildPrintRemoveFromCartEvent(
                          { id: l.design.id, num: l.design.num, variantLabel: variantLabel(l.sel, locale), price: priceOfLine(l) },
                          { currency: analyticsCurrency },
                        ),
                      );
                    }}>
                      <Icon name="trash" /> {t('cart.remove')}
                    </button>
```

- [ ] `src/components/shop/PrintConfigurator.tsx`: add `buildPrintRemoveFromCartEvent` to the existing `@/lib/analytics` import (currently `buildPrintAddToCartEvent, pushDataLayer`), then fire it on the in-cart remove branch (`PrintConfigurator.tsx:191-192`; `design`, `sel`, `locale`, `price`, `analyticsCurrency` are all in scope):

```tsx
            if (inCart) {
              remove(token);
              pushDataLayer(
                buildPrintRemoveFromCartEvent(
                  { id: design.id, num: design.num, variantLabel: variantLabel(sel, locale), price },
                  { currency: analyticsCurrency },
                ),
              );
            } else {
```

- [ ] Verify:

```bash
npm run typecheck && npm run lint
```
Expected: both exit 0.

- [ ] Commit: `feat(analytics): fire remove_from_cart for prints in cart + configurator (N-2b)`.

---

## Task 6 — Full verification

**Acceptance:** unit suites green, typecheck/lint clean, and the print funnel is observable end-to-end; feed `g:id` set ⊇ every emitted print `content_ids`.

- [ ] Full unit run + static checks:

```bash
npm run test && npm run typecheck && npm run lint
```
Expected: `Test Files  … passed`, `Tests  … passed` (feed + analytics deltas included), `tsc --noEmit` exits 0, ESLint clean.

- [ ] Extend the print funnel E2E via the built-in debug buffer. `pushDataLayer` mirrors every event on localhost into `sessionStorage['acc_analytics_debug']` and `document.documentElement.dataset.accAnalyticsDebug` (`analytics.ts:443-469`, active because `isDebugHost()` is true on localhost). The current `e2e/print-configurator.spec.ts` only drives the PDP add flow via `print-add` — it asserts none of the new funnel events. Append one test to its existing `test.describe('fine-art print configurator @ci', …)` block (the describe-level `@ci` tag scopes it; `expect` is already imported) that walks the whole funnel and asserts each event by name from the debug buffer. sessionStorage survives the tile→PDP navigation, and the mid-flow cart-count assertion doubles as a re-render barrier so the second `print-add` click lands on the in-cart (remove) branch:

```ts
  test('fires the print funnel: list → select → view → add → remove', async ({ page }) => {
    // pushDataLayer mirrors each event into sessionStorage on localhost (analytics.ts
    // mirrorDebugEvent); poll because view_item_list / view_item fire in mount effects.
    const events = () =>
      page.evaluate(() =>
        (JSON.parse(sessionStorage.getItem('acc_analytics_debug') ?? '[]') as { event: string }[]).map(
          (e) => e.event,
        ),
      );

    await page.goto('/fine-art-prints');
    await expect.poll(events).toContain('view_item_list');

    await page.getByTestId('print-tile').first().click();
    await expect.poll(events).toContain('select_item');
    await expect.poll(events).toContain('view_item'); // landed on the print PDP

    await page.getByTestId('print-add').click();
    await expect(page.locator('[data-cart-count]')).toHaveText('1');
    await expect.poll(events).toContain('add_to_cart');

    await page.getByTestId('print-add').click(); // in-cart toggle → remove
    await expect.poll(events).toContain('remove_from_cart');
  });
```

```bash
npx playwright test e2e/print-configurator.spec.ts
```
Expected: pass — the three pre-existing configurator tests plus the new `list → select → view → add → remove` funnel test, all green. The new `pushDataLayer` calls are additive and never throw (storage failures are swallowed in `mirrorDebugEvent`).

- [ ] Feed-parity spot check against a locally built feed (optional, non-CI): the print `content_ids` emitted by the pixel (`fap01`/`fap02`/`fap03`) must each appear as `<g:id>` in `/api/feed/meta` and `/api/feed/google`. The Task 1 unit test (`content_ids ⊆ feed ids`) is the durable guard; this is a live confirmation only.

- [ ] Final commit if any verification fix was needed; otherwise the Task 1-5 commits stand.

---

## Notes / deliberate scope limits

- **Feed rows are per-design, not per-variant.** Meta/Google catalog matching is by `g:id`, and the pixel emits the parent design id (`fap0x`) — one row per design fully satisfies the `content_ids ⊆ feed ids` invariant. `// ponytail: one feed row per design; add per-variant rows only if Meta variant-level catalog ads are ever wanted.`
- **Print feed descriptions use static i18n notes**, not the CMS note pipeline (ceramics' `buildFeedItemsCms` CMS path is untouched). Wire CMS print notes only if editors start drafting them.
- **`item_variant` for list/view uses the entry (first-size, unframed) variant**, matching the visible "from" price and the configurator's initial state — consistent with the existing `buildPrintAddToCartEvent` localized label. This does not fix the pre-existing `item_variant` cardinality nit (audit N-12), which is out of scope.
- **GBP is never a feed currency** (feeds quote PLN for `pl`, EUR otherwise, for both ceramics and prints); GBP remains a cookie-driven display currency only. Feed id-matching is currency-independent, so this does not affect the N-2a fix.
- Out of scope (separate audit findings): N-1 token/secret leak, N-3 EM duplication, N-4 server item symmetry, N-5 demand-event currency, F-09 begin_checkout dedup.
