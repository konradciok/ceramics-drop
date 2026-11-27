# Benchmark follow-ups: order value, size, shop chips, Clarity (2026-11-27)

**Status:** active · **Owner:** Konrad · **Source:** a 2026-11-27 benchmark of
another handmade-ceramics storefront (Shopify, porcelain jewellery) against
this codebase. The owner picked five ideas from it: **free-shipping threshold
(#2), cart add-ons (#3), size and scale (#4), family chips on the shop (#7),
session recordings (#8)**. This file splits them into PRs.

This is a work queue for coding agents, in the same format as
[`2026-11-25-conversion-audit-action-plan.md`](2026-11-25-conversion-audit-action-plan.md).
Sales figures stay out of it on purpose: the repo is public.

## How to use this file

- **One task = one session = one PR.** Start a session with: *"Implement task
  B<n> from `docs/plans/2026-11-27-benchmark-aov-plan.md`."* Do not batch tasks.
- Respect the dependency column in the table below. Tasks marked **blocked**
  need an owner decision first (§ Owner decisions). Do not guess the answer.
- Title PRs `feat:` / `fix:` so they cut a release (`AGENTS.md` § Versioning).
  Tick the task's checkbox in this file in the same PR.
- When every task is done or dropped, move this file to `docs/archive/` and
  update `docs/README.md`.

### Rules that apply to every task

The rules in the 2026-11-25 plan (§ "Rules that apply to every task" and
§ "Looking at the site") apply unchanged. In short:

- Read `AGENTS.md` first. Webpack-only build, no `unstable_cache` around
  catalogue reads, catalogue-consuming routes stay dynamic, `Link`/`useRouter`
  from `src/i18n/navigation.ts`.
- Every string lives in `messages/{pl,en,es,de}.json`, all four locales.
  Customer-facing copy is owner-approved (`docs/copy-source-of-truth.md`):
  propose wording in the PR description, mark it as needing approval, never
  invent facts.
- Shipping prices: `getShippingRatesForDisplay()` + `deliveryRatesFor()` only
  (`display-parity.test.ts`).
- Before the PR: `npm run lint && npm run typecheck && npm run test`, plus the
  `@ci` E2E specs named in the task. Look at the change on the hermetic build at
  390 × 844 and 1440 × 900. Never point a browser at production from a cloud
  session.

### What we deliberately do **not** copy from the benchmark

Listed so nobody "helpfully" adds them later:

- **Permanent strike-through prices** (every charm shown "−45%"). An announced
  price reduction must state the lowest price of the previous 30 days (EU
  Omnibus rules; in Poland the price-information act). It is also off-brand
  for one-of-a-kind work.
- **Ratings without a source** ("4,9/5", "over 2000 people", "customer care
  24/7"). Reviews come only from collected, consented reviews (blocked item in
  the 2026-11-25 plan).
- **"Buy 2, get −10%"** as a standing mechanic. In a sell-out drop model it
  teaches buyers to wait for discounts. The flat per-parcel fee plus a
  free-shipping threshold is the honest version of the same nudge.
- **A stack of ~20 third-party apps.** Each new script costs speed and privacy
  review. Everything below uses what is already installed.

---

## Order of work

| Task | PR title (suggested) | Depends on | Owner input | Size |
|---|---|---|---|---|
| [ ] B1 | `feat(analytics): Clarity funnel events and PII masking` | none | none | S |
| [x] B2 | `feat(shop): family chips filter the shop` | none | none | S |
| [ ] B3 | `feat(pdp): size next to the price, measure on mixed tiles, family scale slide` | none | none for code | S–M |
| [ ] B4 | `feat(checkout): free-shipping threshold engine (dark)` | none | none (ships switched off) | M |
| [ ] B5 | `feat(cart): add-ons for the same parcel` | B4 merged (reads its helper) | copy approval | M |
| [ ] B6 | `feat(cart): turn on the free-shipping threshold` | B4, B5 | **blocked: D1–D3** | S–M |
| [ ] B7 | `feat(content): scale photos and capacities` | B3 | **blocked: D4, D5** | S (code) |
| [ ] B8 | `docs(privacy): name session recordings; Clarity runbook` | B1 | **blocked: D6** | S |

B1, B2, B3 and B4 are independent and can run in parallel sessions.

**Timing.** Drop-2 ("Drop Świąteczny") is live. B4 → B5 → B6 only pay off
while there is something to buy, so B4 and B5 should not wait for B6's
decision: both are useful on their own (B5 sells the flat per-parcel fee even
with no threshold). Ask for D1–D3 now so B6 can follow.

**Measuring.** Traffic is too small for A/B tests. Judge B4–B6 on orders, not
sessions: average order value, pieces per order, and the share of orders at or
above the threshold, for comparable windows before and after B6. Pull the
numbers with `npm run orders` (read-only commands) and keep them in the
private report, not in this repo. Add-on uptake shows in GA4 as `add_to_cart`
with `item_list_id = cart_addons` (B5). Use Clarity (B1) for *why*, not for
counts.

---

## Owner decisions (ask before B6, B7, B8)

| Id | Question | Recommendation |
|---|---|---|
| D1 | Free-shipping threshold per currency (PLN / EUR / GBP, whole units), or "no threshold" | Pick a value reachable with one more small piece added to a typical one-piece cart. Illustrations from the current price list (`src/lib/pricing.ts`): at **300 zł**, a mug + a small vase (95 + 239) qualifies, two medium plates (2 × 119) do not, and only a large vase or a large bowl qualifies on its own. At **70 €**, a mug + a small vase (25 + 58) qualifies. The cost is the locker fee on every qualifying order (today 65 zł / 15 € / 13 £ to Poland and the rest of the EU, 43 zł / 10 € / 9 £ within Spain). Margin is the owner's call. |
| D2 | Is the threshold measured **after** a promo discount? | Yes: merchandise subtotal minus discount. Otherwise a code and the threshold stack. Gift-card balance is a payment method, not a discount, so it does not reduce the measured amount. |
| D3 | One threshold for every destination, or a different one for the Spain zone? | One per currency for all zones. Simpler copy; the Spain zone is already cheaper. |
| D4 | Capacity of mugs and bowls (ml), checked on real pieces | Needed before any "ml" appears. Today 300 ml for mugs appears only in a meta description. |
| D5 | One "for scale" photo per family (mug in a hand, plate set with food, vase on a shelf next to a book…) | Shoot brief in B7. |
| D6 | Privacy-policy wording naming Microsoft Clarity (session recordings, heatmaps, consent-gated) | Approve the wording in B8, ideally after a legal check. This plan is not legal advice. |

---

## B1 — Clarity: funnel events and PII masking

**Evidence (verified 2026-11-27).** Clarity **is already installed**. GTM
container v21 (`docs/GTM-NPHLG9NR_v21.json`) has the tag *Microsoft Clarity -
Official* (project `x4ijmp7qch`). It fires on All Pages plus
*ACC - Consent Update* and requires `analytics_storage` consent. Its custom id
is the GA client id. The CSP in `src/middleware.ts` already allows
`https://*.clarity.ms` (report-only; `middleware.test.ts` guards it).

What is missing:

- No Clarity events or tags: recordings cannot be filtered to "reached the
  cart" or "saw a checkout error".
- No explicit masking on pages that echo personal data.
- `docs/analytics-stack.md` does not mention Clarity at all.
- Nobody has confirmed that it records (cloud sessions cannot load
  production).

**Do:**

1. `src/lib/clarity.ts`: tiny, typed, client-only helpers `clarityEvent(name)`,
   `claritySet(key, value)` and `clarityUpgrade(reason)`. Each one is a no-op
   unless `typeof window.clarity === 'function'`. Clarity exists only after
   the consent-gated GTM tag ran, so the helpers are consent-safe by
   construction. Never pass personal data (email, name, address, order id).
2. In `pushDataLayer` (`src/lib/analytics.ts`), mirror an **allowlist** of
   events to `clarityEvent(name)`: `view_item`, `add_to_cart`,
   `remove_from_cart`, `view_cart`, `begin_checkout`, `purchase`; plus the
   `checkout_validation_error` and `payment_failed` engagements, which travel
   as `site_engagement` with an `engagement_type` (`buildEngagementEvent`) —
   mirror the type, not the wrapper event.
   On `begin_checkout`, also call
   `clarityUpgrade('begin_checkout')` so those sessions are kept in full.
   One central call site, not one per component.
3. `claritySet('currency', …)` and `claritySet('drop', <current drop id>)` once
   per page view, from an existing client analytics island (for example where
   `ProductViewAnalytics` / the layout's analytics bootstrap runs). Do not add
   a new global provider for it.
4. Masking: add `data-clarity-mask="true"` to containers that render personal
   data as **text**, not only inputs (Clarity masks input values by default):
   - the cart's contact/delivery form and any collapsed "contact details"
     summary in `CartView.tsx`;
   - the `/konto` pages and `/konto/zamowienia/[id]`;
   - `koszyk/potwierdzenie` and `koszyk/return`, if they show a name or email;
   - newsletter forms are inputs only and need nothing.
   Stripe's PaymentElement is a cross-origin iframe and is not recorded.
5. Clarity's consent API: Microsoft has changed consent handling for EEA/UK
   visitors. **Check the current Clarity docs** for whether the GTM tag, under
   Google Consent Mode, still needs an explicit `clarity('consentv2', …)`
   call. If it does, call it from `setConsent()` next to the existing
   `gtag('consent','update',…)`, including a revoke. Write down what you
   found and why in the PR. Do not guess.
6. Docs: add a Clarity section to `docs/analytics-stack.md` (tag, consent
   gating, events mirrored, masking rule, "no PII in Clarity calls").

**Don't:** load Clarity from code, add a second Clarity script, or change the
GTM tag in this PR. The tag stays managed in GTM as it is today.

**Tests:** unit tests for `src/lib/clarity.ts` (no-op without
`window.clarity`; forwards with a stub). A `pushDataLayer` test that
allowlisted events reach the stub and others do not. `analytics-token-leak`
and `consent-banner` E2E stay green.

**Acceptance:**
- With consent denied, `window.clarity` is never called.
- With a stubbed `window.clarity`, adding a piece and clicking pay records
  `add_to_cart`, `begin_checkout` and the upgrade.
- Grep shows no Clarity call carries an email, name, address or order id.

**Operator follow-up (no code, after merge):** in the Clarity dashboard,
confirm sessions arrive from the last 7 days. Check that masking mode is at
least *Balanced* and exclude the studio's own IPs. Create funnels PDP → cart
(`add_to_cart`) → `begin_checkout` → `purchase`. Watch 10 recordings of
sessions with `begin_checkout` and no `purchase` each week during the drop.
Note findings in the private report.

## B2 — Family chips filter the shop

**Evidence.** `/sklep` (`CeramicShopScreen.tsx`) has a `shop-switch` row, but
its items are **links to the collection pages**, which also list sold pieces.
The "available now" grid below cannot be narrowed to one family: on a phone,
someone looking for mugs scrolls past every plate.

**Do:**

1. `src/app/[locale]/(shop)/sklep/page.tsx` reads
   `searchParams.rodzina`. The shop has its own route group because
   `(collections)/loading.tsx` puts a Suspense boundary around the page: a
   `force-dynamic` page is then streamed into a hidden div that only the inline
   script reveals, so without JavaScript visitors would see the skeleton and
   the chip links would be unclickable. The URL is unchanged.

   `rodzina` is valid only if it is a visible `CategorySlug` (the same set as
   `VISIBLE_CATEGORY_ORDER`); anything else is ignored and the full shop
   renders. The route stays `force-dynamic`. Canonical stays `/sklep`
   (`alternatesFor` already builds it without the query string). Confirm the
   metadata does not pick up the query.
2. `CeramicShopScreen` takes an optional `family`. Replace the `shop-switch`
   links with chips:
   - "All (N)" plus one chip per family **with at least one piece available**,
     each with its available count;
   - each chip is a `Link` to `/sklep?rodzina=<slug>`, so there is no client
     JS and it works without hydration;
   - the active chip has `aria-current="true"`.
   Reuse the existing `.shop-switch` horizontal scroller and edge fade.
3. With a family chosen, filter **both** the available grid and the
   "not available right now" section to that family. Append the localized
   count only while filtered (`availableTitleFiltered`, e.g.
   "Dostępne teraz (47)"); the unfiltered `availableTitle` stays exactly as
   written. A filtered family with nothing on sale keeps its own lists and the
   `(0)` heading, and must not show the shop-wide empty notice.

   The family cards section stays unfiltered: it is how visitors reach the
   collection pages, which lose their entry point in step 2.
4. Analytics: pass `listId = sklep-<slug>` to `Gallery` when filtered, so
   `view_item_list`/`select_item` show which chips sell.
5. Home (`src/app/[locale]/page.tsx`): under the "available now" heading, add
   the same chip row (families with available pieces only), linking to
   `/sklep?rodzina=<slug>`. Extract the chip row into one shared component.

**Copy:** reuse `nav.*` family names. "All" needs one new key in four
locales; propose it.

**Tests:** extend `CeramicShopScreen.test.ts` (filtering, unknown slug,
hidden family, family with 0 available gets no chip). Update
`e2e/ceramic-shop.spec.ts`: tap a chip on mobile → URL has `?rodzina=`, grid
shows only that family, back button returns to all.
`e2e/locale-switch-sticks.spec.ts` must stay green: the chip links must keep
the locale, which `Link` from `src/i18n/navigation.ts` handles.

**Acceptance:**
- `/sklep?rodzina=kubki` lists only mugs, in both sections.
- `/sklep?rodzina=nonsense` equals `/sklep`.
- Canonical of both is `/sklep`.
- Chips scroll horizontally at 390 px with no page overflow.

## B3 — Size next to the price, measure on mixed tiles, family scale slide

**Evidence.** The PDP shows dimensions only in the spec table under the
delivery block (`ProductPageScreen.tsx`, `lb-specs` → `lightbox.specDims`).
Tiles show name and price only (`ProductTile.tsx`, `tile-meta`). On `/sklep`
and home, where families are mixed, a ⌀ 14 cm plate and a ⌀ 24 cm plate look
the same size. The benchmark leads the details with the size and a ruler icon.

**Do:**

1. PDP: add a size line directly under `.pdp-price`, with a ruler icon (add
   `ruler` to `src/components/ui/Icon.tsx` if missing) and
   `t('lightbox.approx')` + `product.measure`. Remove the dimensions row from
   the PDP spec table so it is not shown twice. Keep it in the lightbox,
   which has no price-adjacent line.
2. Tiles: optional `showMeasure` prop on `ProductTile`, passed through
   `Gallery`. Turn it on only where families mix: `/sklep` available and
   unavailable grids, the home row, and the cart add-ons (B5). Keep it off on
   collection pages, where every tile has the same measure. One short muted
   line under the name; check it does not reintroduce the T4 mobile wrap
   problem (`e2e/mobile-tiles-consent.spec.ts`).
3. Family scale slide (dormant until B7):
   - `src/lib/scale-images.ts` exports
     `FAMILY_SCALE_IMAGES: Partial<Record<CategorySlug, { src: string }>>`,
     empty in this PR.
   - `ProductPageGallery` takes an optional `scaleImage` and renders it as
     the **last** slide, with a visible caption (new copy, needs approval):
     *"For scale: a piece from the same series, not this one."* This is
     mandatory: every piece is unique and the photo must not pass as the
     piece.
   - The slide is **not** added to JSON-LD `image`, the Meta feed, the tile
     hover image, or the photo-count chip.

**Tests:** `ProductPageScreen.test.ts` covers the size line and that the spec
table no longer duplicates it. A unit test that `FAMILY_SCALE_IMAGES` entries
point at files that exist in `public/uploads/`, the same guard style as other
asset tests. `e2e/product-gallery-nav.spec.ts` stays green with an empty map.
Add one case with a fixture entry if the spec can inject it cheaply;
otherwise cover it in a component test.

**Acceptance:**
- On a PDP at 390 px the size is visible without scrolling past the price.
- Mixed-family tiles show the measure; collection tiles do not.
- With the map empty, the gallery is unchanged.

## B4 — Free-shipping threshold engine (ships switched off)

**Evidence.** Delivery is a flat fee per parcel. Today it is 65 zł / 15 € /
13 £ to Poland and the rest of the EU, against a 95 zł / 25 € mug
(`DEFAULT_LOCKER_SHIPPING`; CMS `lockers` resource). Shipping is computed in
four places that must stay identical:

- the checkout charge: `src/app/api/checkout/route.ts`, the `shipMinor` block;
- the cart estimate: `CartView.tsx`, `shipCost` / `summary`;
- the PDP quote: `src/lib/pdp-delivery.ts`, `pdpDeliveryQuote`;
- JSON-LD: `src/lib/seo/structured-data.ts`, `shippingDetailsFor`.

This PR adds the threshold to all four with the threshold **unset**, so
production behaviour does not change until B6.

**Do:**

1. New `src/lib/free-shipping.ts` (pure, client-safe, no env reads):
   - `FREE_SHIPPING_THRESHOLD: Record<Currency, number | null>`, whole
     units, **all `null`** in this PR.
   - `freeShippingThreshold(currency)`.
   - `qualifiesForFreeShipping(netMerchandise, threshold)`, where
     `netMerchandise` = subtotal − promo discount (D2), in the caller's
     units.
   - `freeShippingProgress(netMerchandise, threshold)` →
     `{ remaining, ratio, unlocked } | null` (`null` when the threshold is
     unset).
   - Shape it so B6 only changes the constant. If the owner later wants the
     value in the CMS, move it into the `shipping_rates` bundle then, not now.
2. **Checkout** (`route.ts`), after `computePromoDiscountMinor`. The order
   matters because the discount's Stripe-minimum clamp reads shipping:
   `baseShip` → `discount = compute(promo, subtotal, baseShip)` →
   `shipMinor = qualifies(subtotal − discount) ? 0 : baseShip` → if shipping
   was waived and there is a promo, recompute
   `discount = compute(promo, subtotal, 0)`. The recompute cannot change the
   discount when net ≥ threshold > Stripe minimum. Assert that invariant in a
   test. Gift-card orders keep shipping 0 as today. Private-sale and
   gift-card-balance checkouts go through the same block; cover both in
   tests. The `amounts` snapshot returned to the cart then carries the real
   value.
3. **Cart** (`CartView.tsx`): `shipCost` becomes the base rate unless the
   cart's net merchandise (subtotal − `promoDiscount`) qualifies. The summary
   row already prints `cart.free` at 0. Hide the per-parcel note
   (`summary.shipping > 0` already does). No new UI in this PR.
4. **PDP** (`pdp-delivery.ts`): when the piece's own price qualifies,
   `total` = item and the rows show free delivery. Use `cart.free`; no new
   copy.
5. **JSON-LD** (`structured-data.ts`): per offer, `shippingRate.value` = 0
   when that piece alone qualifies in the locale's JSON-LD currency.
   Otherwise unchanged. Do not invent a schema.org threshold property.
6. Grep for anything else that derives shipping or totals, e.g.
   `subtotal + shipping` in emails (`src/lib/email.ts`), admin
   (`src/app/admin/orders/[id]/page.tsx`), `scripts/` and `src/server/`.
   They read stored `orders.shipping`, which is right. Confirm a stored 0
   renders sensibly ("Gratis" / "0,00 zł") in the confirmation email and
   admin.

**Tests:**
- Unit tests for `free-shipping.ts`.
- `route.test.ts` cases with an injected threshold (refactor so the route
  reads it through `freeShippingThreshold`, which tests can mock): just
  below, exactly at, above; promo pushing a cart below the threshold
  (charged shipping); promo with net still above (free shipping, discount
  unchanged); ES vs EU zone; private sale; gift-card balance.
- `pdp-delivery.test.ts` and the structured-data tests with a threshold.
- Extend `display-parity.test.ts` with a case where cart, PDP, JSON-LD and
  checkout all see the same non-null threshold and agree on 0 vs base rate.

**Acceptance:**
- With every threshold `null`, all existing unit and E2E tests pass
  untouched: no behaviour change.
- With a test threshold, the four surfaces agree in every case above.

## B5 — Cart add-ons: "same parcel, same delivery fee"

**Evidence.** The cart (`CartView.tsx`) offers nothing to add. The PDP has a
sibling strip (`pickPdpSiblings`), the cart does not. Delivery is one fee per
parcel (`cart.perParcel`), so a second piece costs no extra shipping. That is
a true, strong argument the cart never makes. The benchmark's drawer has
"Abbinali al tuo ordine" (pair it with your order).

**Do:**

1. Server (`src/app/[locale]/koszyk/page.tsx`, already `force-dynamic`):
   - load `loadCeramicShopProducts()` → `summariseCeramicShop()` →
     `available`, in a best-effort `.catch(() => [])` like the home page;
   - pass a **small** candidate list to `CartView` as `addOnCandidates`: the 3
     cheapest available pieces per family, as `Product` objects;
   - no `unstable_cache`.
2. New pure `src/lib/cart-addons.ts`:
   `pickCartAddOns(candidates, { cartIds, unavailableIds, remaining, currency, max = 3 })`.
   - Drop pieces in the cart or known unavailable (`availableIds` from the
     cart's `/api/inventory` fetch).
   - If `remaining > 0` (a threshold is set and not reached, from B4's
     `freeShippingProgress`): first the cheapest pieces whose price ≥
     `remaining`, then the rest by descending price.
   - Otherwise: the cheapest pieces, at most one per family, families not
     already in the cart first.
   - Ties keep catalogue order. Fully unit-tested.
3. UI in `CartView.tsx`, in `cart-main` after the item list and before the
   delivery form:
   - heading plus one line of copy (proposal: *"Add to the same parcel —
     delivery costs the same"*);
   - up to 3 compact cards (image, name, measure from B3, price, add button);
     a horizontal scroller on phones.
   - Add through `useCartToggle(product)` from `AddToCartButton.tsx`, extended
     to accept `itemListId`/`itemListName` so `add_to_cart` carries
     `item_list_id = cart_addons`.
   - Fire one `view_item_list` (`cart_addons`) when the strip first renders
     with items.
   - The new line then appears through the existing `useCartLines` refetch.
4. Hide the strip when:
   - a PaymentIntent exists (`clientSecret`) or `submitting`, because the
     amount is locked;
   - the cart is in private-sale mode (`privateSaleToken`), because the
     bundle must match exactly;
   - the cart holds only gift cards;
   - there are no candidates.
   Never show a piece already in the cart.

**Copy (needs approval):** heading, the per-parcel line, card button (reuse
`lightbox.add` if it fits).

**Tests:**
- Unit tests for `pickCartAddOns` (both modes, exclusions, family diversity,
  max).
- Component/route tests that the strip is hidden in each case above.
- New `@ci` E2E `e2e/cart-addons.spec.ts`: add one piece → cart shows 3
  add-ons, none in the cart → add one → it moves into the list, the strip
  refills, the summary subtotal updates → go to payment → strip gone.
- `cart-interactions`, `mobile-cart-layout`, `promo-code` and
  `analytics-funnel` stay green.

**Acceptance:**
- An add-on lands in the cart with one tap and the totals update.
- `add_to_cart` carries `item_list_id: 'cart_addons'`.
- No strip in the payment step or with a private-sale link.
- Page weight: the candidate list is ≤ 3 per family.

## B6 — Turn on the threshold (blocked: D1–D3)

**Do:**

1. Set `FREE_SHIPPING_THRESHOLD` to the owner's values (D1).
2. Cart progress block, above the delivery options and in the phone summary
   bar's expanded state:
   - unlocked: one line;
   - not unlocked: *"X more for free delivery"* plus a thin progress bar
     (`role="progressbar"` with `aria-valuenow`/`aria-valuemax`, not colour
     alone).
   Amounts come from `freeShippingProgress` in the display currency. Hidden
   in the payment step, where totals are locked anyway.
3. PDP delivery block: one line *"Free delivery from X"* under the rate when
   the piece does not qualify alone; *"Free delivery"* when it does.
4. Copy that states delivery terms:
   - `/dostawa-i-zwroty` (`shipping.s1P`), with the threshold as a
     placeholder formatted like `{lockerEs}` (`src/lib/shipping-copy.ts`);
   - the terms of sale delivery clause (`terms.s3P`/`s4P`), owner-approved;
   - `docs/copy-source-of-truth.md` §13.
   Optional: the announcement bar (`announce`), only if the owner wants it
   there. It is shared with the drop wording.
5. Update `docs/STATUS.md` (new row: threshold values, date) and
   `docs/agent-context/pricing-shipping.md`.

**Risk to accept knowingly.** After a partial withdrawal (one piece of two
returned) the remaining order may fall below the threshold. Shipping was 0
and is not charged afterwards; the refund covers the returned piece. A buyer
could game this. At this volume, accept it and watch it. Do not add
clawback logic.

**Tests:**
- Copy guards in `src/i18n/messages.test.ts`: the threshold placeholder is
  present in all four locales.
- `e2e/free-shipping.spec.ts` (`@ci`): below the threshold, progress shows
  the right remaining amount in PLN and EUR; adding an add-on (B5) over the
  threshold → summary shows `Gratis`, the bar completes.
- One test-mode purchase over the threshold (`@checkout-edge` or manual)
  confirms Stripe is charged without shipping. Record it in the PR.

**After release:** snapshot the before/after order metrics (§ Measuring)
into the private report after two to three weeks.

## B7 — Scale photos and capacities (blocked: D4, D5)

**Shoot brief for the studio:**
- one photo per family, natural light, 4:5, the piece in use next to
  something of known size;
- a mug held in a hand;
- a small plate with a pastry or cookie;
- a large plate set for a meal;
- a vase with stems on a shelf beside a book;
- a bowl with fruit.
Any piece of the family will do, since the caption says it is not this
piece. Originals go in `design/uploads/scale/<family>.png`, then
`npm run optimize-images`.

**Do:**
- Fill `FAMILY_SCALE_IMAGES`.
- Add the measured capacity to the families' `measure` strings: code `SPECS`
  in `src/lib/products.ts` and the DB `products.measure` through
  `npm run catalog:backfill` per `docs/new-drop-runbook.md`, or the CMS
  structural edit. Use the format from `Product.measure`'s doc comment,
  `9 × 9 cm · 300 ml`.
- No other code.

**Acceptance:**
- Every family with a photo shows it as the captioned last slide.
- Capacities appear only where the owner measured them.

## B8 — Privacy policy and Clarity runbook (blocked: D6)

**Do:**
- Add to the privacy policy cookies section (`privacy.s5P` and its
  neighbours, four locales) one sentence naming Microsoft Clarity:
  - session recordings and heatmaps;
  - only after analytics consent;
  - form fields masked.
  Owner-approved wording only.
- Add the weekly review routine from B1's operator follow-up to
  `docs/analytics-stack.md`.
- Add a `docs/STATUS.md` row (Clarity: installed, consent-gated, events
  mirrored, last verified date).

**Acceptance:** `messages.test.ts` passes. The policy text matches what the
GTM tag actually does (consent type `analytics_storage`).
