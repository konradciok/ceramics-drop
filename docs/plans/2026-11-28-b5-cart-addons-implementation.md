# B5 implementation plan — cart add-ons "same parcel, same delivery fee" (2026-11-28)

**Status:** active · **Owner:** Konrad · **Parent:** task B5 in
[`2026-11-27-benchmark-aov-plan.md`](2026-11-27-benchmark-aov-plan.md). That
file holds the goal and acceptance criteria; this one is the step-by-step
build. One PR. Title: `feat(cart): add-ons for the same parcel`.

## Why B5 is next (ROI ranking, 2026-11-28)

The ranking is qualitative: the repo holds no conversion data, and sales
figures stay out of it on purpose.

| Task | State on `main` | Value on its own | Verdict |
|---|---|---|---|
| B2 chips | done (#464) | — | — |
| B8 privacy wording | wording done (#465); runbook left | none (compliance) | small leftover |
| **B6** threshold on | blocked on D1–D3, needs B4 | **highest** (attacks the 65 zł / 15 € fee on 69–95 zł pieces) | ask for D1–D3 now |
| B4 engine (dark) | open | **zero** until B6 | do right before B6 |
| **B5** add-ons | open | **direct order-value lever, no owner decision** | **do now** |
| B3 size | open | indirect (fewer size doubts) | after B5 |
| B1 Clarity events | open; consent part settled by #465 | insight only | after B5 |

B5 is the highest-ROI task that can ship now, for three reasons:

- **It acts on order value directly.** Delivery is one fee per parcel, so a
  second piece adds no shipping. Today the cart never says so at the moment
  of decision, and offers nothing to add.
- **It needs no business decision,** only copy approval.
- **Timing.** Drop-2 ("Drop Świąteczny") is live now. A Christmas buyer is
  the likeliest to add a small second piece, and that window closes in
  December.

**Change against the parent plan.** B5 no longer depends on B4. The picker
takes an optional `remaining` amount. B5 ships without it, and B6 wires it
in once the threshold exists. The table in the parent plan is updated to
match.

## What exists today (verified on `main` @ `f15f739`)

**Cart page**
- `src/app/[locale]/koszyk/page.tsx` is `force-dynamic`. It reads shipping
  rates and destinations and renders `<CartView … />`.
- It loads no catalogue.

**Cart component** (`src/components/shop/CartView.tsx`, ~1950 lines)
- `useCartLines(ids, locale)` resolves cart tokens into lines through
  `/api/cart-lines`. Adding an id to the store makes the new line appear on
  its own.
- `/api/inventory` is fetched once on mount, into `availableIds` and
  `inventoryReady`.
- Flags that mark states where the cart must not change:
  - `privateSale` (`?sale=` locked bundle);
  - `clientSecret` (PaymentIntent exists, amount locked);
  - `submitting`;
  - `editingDelivery`.
- The item list (`.cart-list`, rows `data-testid="cart-line"`) is followed by
  the delivery `<form id={DELIVERY_FORM_ID}>`, rendered only while
  `!clientSecret`.

**Catalogue loaders** (both live in `src/components/shop/CeramicShopScreen.tsx`)
- `loadCeramicShopProducts()` returns the public catalogue with the live
  sold/showroom overlay. It is best-effort; the home page wraps it in
  `.catch(() => [])`.
- `summariseCeramicShop(products)` returns `{ available, … }`: the
  purchasable pieces, in family order.

**Analytics**
- `useCartToggle(product)` (`src/components/shop/AddToCartButton.tsx`) does
  the store toggle and fires `add_to_cart` / `remove_from_cart`.
- `buildAddToCartEvent`'s `EventOptions` (`src/lib/analytics.ts`) has **no**
  `itemListId`/`itemListName` yet. `toAnalyticsItem` already accepts them.
- `buildViewItemListEvent(products, { itemListId, itemListName, currency, itemPrices })`
  exists. `Gallery.tsx` shows how to fire it once per mount.

**Other constraints**
- `MAX_CART` (`src/lib/checkout.ts`) is the whole registry, so add-ons
  cannot hit the cap.
- Cart styles live in `src/styles/site.css` (`.cart-row`, `.cart-list` …).
- E2E: `e2e/helpers/checkout.ts` provides `resetCart`, `appendToCart`,
  `goToCart`, `dismissConsent`, `mockGeowidget` and `sel`. Existing cart specs
  mock `/api/inventory` with only their own piece available. That matters
  below.

## Design decisions

1. **Show add-ons only after inventory is known.** A candidate is shown only
   when `availableIds` is loaded and contains it.
   - The server list may be a few minutes stale; the inventory read is fresh
     and already drives sold-piece pruning.
   - No flicker of a piece that vanishes a second later.
   - Existing E2E specs mock inventory with only their own piece, so they see
     **no** add-ons and stay untouched.
2. **Hide the strip whenever the cart must not change:** `privateSale ||
   clientSecret || submitting || editingDelivery`, no ceramic lines, or no
   candidates left. Adding a piece after the PaymentIntent exists would
   desync the locked amount.
3. **Keep the payload small.** The server sends at most 3 cheapest available
   pieces per family (≤ 33 `Product`s), not the whole drop.
4. **Selection rule with no threshold** (`remaining` undefined):
   - cheapest first;
   - at most one per family;
   - families not already in the cart come before families that are;
   - ties keep catalogue order;
   - max 3.
   Small pieces (69–95 zł) are the easiest "yes" next to a parcel fee.
5. **Selection rule with a threshold** (B6 passes `remaining > 0`): first the
   cheapest pieces with price ≥ `remaining`, then the rest by descending
   price. Fully unit-tested now, so B6 only passes the number.
6. **A separate component, `CartAddOns.tsx`.** CartView only decides whether
   and where to render it.
7. **No `unstable_cache`, no new API route.** The cart page is already
   dynamic; one more best-effort catalogue read there is acceptable. Do not
   introduce a client fetch of the catalogue.

## Steps

### 1. Pure picker — `src/lib/cart-addons.ts` (+ `cart-addons.test.ts`)

```ts
export const CART_ADDONS_MAX = 3;
export const CART_ADDON_CANDIDATES_PER_FAMILY = 3;

/** Server side: the cheapest few available pieces per family, family order kept. */
export function cartAddOnCandidates(available: readonly Product[], perFamily = CART_ADDON_CANDIDATES_PER_FAMILY): Product[];

/** Client side: which candidates to show. Pure. */
export function pickCartAddOns(
  candidates: readonly Product[],
  opts: {
    cartIds: ReadonlySet<string>;
    availableIds: ReadonlySet<string>;   // only these may be shown
    priceOf: (p: Product) => number;     // display-currency price (priceOfCurrency)
    remaining?: number;                  // B6: amount left to the free-shipping threshold
    max?: number;
  },
): Product[];
```

Tests:
- excludes cart ids and anything not in `availableIds`;
- one per family; families not in the cart first;
- cheapest first, with stable ties;
- `max` respected;
- empty input gives empty output;
- `remaining` mode: qualifying pieces cheapest-first, then non-qualifying by
  descending price;
- `remaining <= 0` behaves like undefined;
- prices compared in the given currency: a fixture where the PLN and EUR
  orders differ;
- `cartAddOnCandidates` caps per family and keeps family order.

### 2. Analytics option — `src/lib/analytics.ts`

- Add optional `itemListId?` / `itemListName?` to `EventOptions`. Pass them
  into `toAnalyticsItem` in `buildAddToCartEvent` (and in
  `buildRemoveFromCartEvent` for symmetry). No change for existing callers.
- `useCartToggle(product, listOpts?)` in `AddToCartButton.tsx` forwards
  `listOpts` into the event options.
- Test in `analytics.test.ts`: `add_to_cart` with `itemListId: 'cart_addons'`
  puts it on the item.
- Check `docs/analytics-stack.md` / the GTM export for whether the GA4
  add_to_cart tag forwards item-level `item_list_id` (it should, via
  ecommerce items). Note the answer in the PR; no GTM change is expected.

### 3. Server data — `src/app/[locale]/koszyk/page.tsx`

- Add `loadCeramicShopProducts().catch(() => [])` to the existing
  `Promise.all`, then
  `cartAddOnCandidates(summariseCeramicShop(products).available)`.
- Pass the result to `CartView` as `addOnCandidates`.
- Do **not** load it when `saleToken` is set (private sale never shows
  add-ons); pass `[]`.

### 4. Component — `src/components/shop/CartAddOns.tsx` (`'use client'`)

Props: `{ candidates: Product[]; cartIds: string[]; availableIds: Set<string> | null }`.

- Returns `null` when `availableIds` is `null`, or when `pickCartAddOns`
  returns nothing.
- Renders a `<section className="cart-addons" data-testid="cart-addons"
  aria-labelledby=…>` with:
  - a heading `t('cart.addons.title')`;
  - one line `t('cart.addons.lead')`;
  - a list of cards, each `data-testid="cart-addon"` with
    `data-product-id`.
- Each card has:
  - thumbnail `<img>` via `srcSet()`, natural ratio, never cropped, no
    `next/image`, linking to the PDP via `Link` from `@/i18n/navigation`;
  - display name via `productDisplayName`;
  - `product.measure` as a muted line (helps size judgement; B3 does the
    rest);
  - the price via `currencyFormatter(useCurrency())` + `priceOfCurrency`;
  - an add button (`data-testid="cart-addon-add"`) calling
    `useCartToggle(product, { itemListId: 'cart_addons', itemListName: 'cart_addons' }).toggle`.
  The toggle needs one hook per card, so make the card its own small
  component.
- After a tap, the piece enters the store and drops out of the picker on the
  next render. The new line appears through `useCartLines`. Focus: move it to
  the strip heading (or the next card's button) so keyboard users are not
  dropped to `<body>` when the card unmounts.
- `view_item_list` with `itemListId: 'cart_addons'`, fired **once per mount**
  when the first non-empty pick renders (guard with a ref, as `Gallery.tsx`
  does). Do not re-fire on every refill.

### 5. Wire into `CartView.tsx`

- New prop `addOnCandidates: Product[]`, optional with default `[]` so other
  call sites and tests are unaffected.
- Render `<CartAddOns … />` between `.cart-list` (and the undo toast) and the
  delivery form, only when
  `!privateSale && !clientSecret && !submitting && !editingDelivery`.
  Pass `cartIds = ids` (store ids) and `availableIds`.
- No other change to CartView logic.

### 6. Styles — `src/styles/site.css`

- `.cart-addons` uses the existing tokens (`--c-*`, `--gut`, `--r-*`).
- Desktop: three cards in a row.
- ≤ 560 px: a horizontal scroller (`overflow-x: auto`, scroll-snap, edge
  fade as in `.shop-switch`), cards ~70 % width, **no page overflow**.
- Buttons at least 44 px tall.
- Check it does not push the pay CTA further on phones than needed. The
  strip sits above the delivery form, as in the benchmark; if T5's mobile
  reachability work (2026-11-25 plan) regresses, move it under the delivery
  form on phones only.

### 7. Copy — `messages/{pl,en,es,de}.json` (needs owner approval)

New keys under `cart.addons`, proposed wording:

| key | pl | en |
|---|---|---|
| `title` | Dobierz do tej samej paczki | Add to the same parcel |
| `lead` | Dostawa kosztuje tyle samo — płacisz jedną opłatę za całą paczkę. | Delivery costs the same — one fee covers the whole parcel. |
| `add` | Dodaj | Add |

- es/de: translate the same meaning.
- The `lead` repeats a fact already approved in `pdp.perParcel` /
  `shipping.s1P` (a flat fee per order), so it states nothing new. Mark it
  for approval in the PR anyway.

### 8. Tests

**Unit and component**
- `cart-addons.test.ts` (step 1) and the `analytics.test.ts` case (step 2).
- A component test for `CartAddOns`:
  - nothing before `availableIds` loads;
  - nothing when every candidate is in the cart;
  - renders ≤ 3 cards with the add button.
- Visibility of the strip for `privateSale`, `clientSecret` and `submitting`
  belongs to CartView. Cover it through the existing CartView test pattern if
  one exists; otherwise in the E2E below.

**E2E — new `e2e/cart-addons.spec.ts`, tagged `@ci`**
1. Seed one piece (`appendToCart`) and open `/koszyk`.
2. Mock `/api/inventory` so the seeded piece and the server's candidates are
   available. First check what the hermetic `/api/inventory` returns under
   `E2E_CERAMIC_SALE_FIXTURE=1`. If it already lists every piece, do not
   mock it.
3. Expect `cart-addons` with 1–3 `cart-addon` cards, none of them the seeded
   piece.
4. Tap `cart-addon-add` on the first card:
   - `cart-line` count becomes 2;
   - that id is gone from the strip;
   - `summary-subtotal` grows by the card's price;
   - `summary-shipping` is unchanged (flat fee).
5. A dataLayer check (the pattern in `analytics-funnel.spec.ts`):
   `add_to_cart` has `items[0].item_list_id === 'cart_addons'`.
6. 390 × 844: no horizontal page overflow (`document.documentElement.scrollWidth
   <= innerWidth`).

**Must stay green:** `cart-interactions`, `mobile-cart-layout`,
`promo-code`, `analytics-funnel`, `payment-step`, `checkout-409`,
`purchase-two-categories-paczkomat`, plus `npm run lint && npm run typecheck
&& npm run test`.

### 9. Docs, same PR

- Tick B5 in the parent plan.
- `docs/analytics-stack.md`: the `cart_addons` list id.
- `docs/agent-context/storefront-surfaces.md`: one line under the cart.
- `docs/STATUS.md`: a row only if the owner wants it tracked.

## Out of scope

- Threshold mode in the UI: B6 passes `remaining` once B4 lands.
- "Goes with" pairing by motif (2026-11-25 plan § Later).
- Add-ons on the gift-card track.
- Add-ons in the payment step.

## Measuring after release

- In GA4, under `add_to_cart` by `item_list_id`, `cart_addons` shows uptake.
- From orders (`npm run orders`, read-only), compare pieces per order and
  average order value for comparable windows before and after.
- Keep the numbers in the private report, not in this repo (public).
- Expect small absolute counts. Read them as direction, not proof.
