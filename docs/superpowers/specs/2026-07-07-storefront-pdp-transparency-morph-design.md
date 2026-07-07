# Spec C — PDP: pricing transparency + view-transition morph

**Status:** validated design (brainstormed 2026-07-07), not yet implemented.
**Part of:** the **2026 Storefront Upgrade** — a four-spec set in this directory (A/B/C/D). No separate index doc is tracked on this branch yet. Build order **A → C → B → D**; C consumes Spec A primitives where useful and owns the View Transitions integration.
**Primary success criterion:** conversion — specifically **add-to-cart rate** and **PDP→checkout completion**.

C ships as **two independently-PR-able tiers**:
- **C-core** — pricing & shipping transparency. High-confidence conversion, server-only, zero JS. The sure win.
- **C-morph** — tile→hero view-transition. Polish, ~zero direct conversion impact, client-side, cuttable. Ships *after* C-core in its own PR; C-core never waits on it.

## Hard constraints (inherited)

- No `tokens.css` changes. Build stays `next build --webpack`. Mobile-first. `prefers-reduced-motion` respected.
- **Preserve the `(pdp)` route group's no-`loading.tsx` behavior** — `notFound()` must keep returning a real HTTP 404. View transitions are layered over successful navigations only and must not introduce a Suspense/loading shell.

## Grounding (current state)

- `ProductPageScreen.tsx` (server) renders `.pdp-body`: eyebrow, `<h1>`, `.pdp-price`, note, `.lb-specs`, then `<AddToCartButton>`. It already resolves `currency` via `getCurrency(locale)` and `currencyFormatter`.
- `pricing.ts` holds flat shipping constants per method per currency: `SHIPPING_PLN/EUR/GBP` = `{ paczkomat, kurier, odbior }` (e.g. PLN 20 / 30 / 0). Shipping is **flat and known**, not weight/distance-based.
- **No VAT, no duties, no customs** anywhere — `invoice.ts` builds a *no-VAT* invoice. The draft plan's "duties" does not apply to this store.
- Shipping currently first appears at **checkout**; the PDP shows item price only. Closing that gap is the conversion lever.

---

## C-core · Pricing & shipping transparency

### What it does

Surface the true all-in cost on the PDP (and mirror in cart) so the buyer sees the real number before adding to cart, killing the surprise-shipping abandonment trigger.

### Design

A new **server** sub-block in `.pdp-body`, placed between `.pdp-price` and `<AddToCartButton>`. All values come from existing constants + the already-resolved `currency`/`fmt` — **no new data source, no client JS**.

1. **Estimated total from `{item + locker}`** — prominent line. Anchored on `paczkomat` (the cheapest *shipped* method and the InPost default), labelled as an estimate. This is an honest floor: pickup is cheaper, courier is dearer, both shown below.
2. **Options list** (currency-aware, from `SHIPPING_*`):
   - Warsaw pickup — **free** (`odbior`)
   - Locker — `{SHIPPING[paczkomat]}`
   - Courier — `{SHIPPING[kurier]}`
3. **Trust line** — "the price you see is the price you pay — no hidden fees." New i18n keys in `messages/{pl,en,es,de}.json`; exact copy at implementation.

### Cart mirror — already satisfied

`CartView` **already** shows a full cost breakdown — pieces subtotal, delivery, and total — in its sticky summary (`CartView.tsx` pieces/delivery/total rows). So there is **no new cart UI** in C-core; the only action is to verify parity (same currency, same shipping constants) once the PDP block ships. C-core is scoped to `PdpDelivery` only.

### Copy dependency (must resolve before ship, not invented here)

For **UK / GBP** buyers, a parcel from Poland may attract import charges on the recipient's end. The "no hidden fees" claim must be accurate per destination. The spec **requires** the studio to confirm who bears any cross-border charges (DDP vs DDU); the implementation copy encodes whatever they confirm. Do not assert "no customs" for GBP without that confirmation.

At implementation, verify the PDP estimate matches what the buyer actually pays: use the Stripe MCP to confirm the created PaymentIntent's amount + currency (minor units) equal `item + shipping` for the chosen method, and that the trust-line copy doesn't contradict Stripe's receipt line items.

### Success metric (lightweight)

- Target: **PDP→checkout completion** and **add-to-cart rate** on ceramic PDPs.
- Success threshold: a measurable lift (or reduced drop at the checkout shipping step) after launch — exact baseline read at impl.
- Instrumentation: extend the existing single-`site_engagement` event keyed by `engagement_type` (e.g. an `engagement_type` for delivery-info exposure); **event wiring deferred to the implementation plan** per the round's instrumentation decision.

### Verification

- Server-rendered, so a Playwright/unit assertion: for each currency (`pln`/`eur`/`gbp`), the PDP shows the estimated total = `priceOfCurrency(product,currency) + SHIPPING[currency].paczkomat` and lists all three options with correct amounts. This is the runnable check that also satisfies Spec A's deferred consumer test if the block uses `.reveal`.

### Risks

- **Estimate feels low if buyer picks courier.** Mitigation: label it "from"/"estimated", show courier's exact higher price in the same block — no concealment.
- **Copy inaccuracy for cross-border.** Mitigation: the studio-confirmation dependency above gates the trust-line wording.

---

## C-morph · Tile→hero view-transition (enhancement, separate PR)

### What it does

When the user **navigates** to a PDP by clicking a linked tile, that tile's image morphs into the PDP hero image, for a premium, continuous feel. Pure enhancement.

**Which surfaces actually navigate (important):** the collection grid's `ProductTile` (in `Gallery`) opens a **lightbox** for unsold pieces — it does *not* navigate — so the primary browse flow is out of the morph's reach. The real PDP-navigation surfaces are: `ProductTileLink` (the PDP "more from" strip → next PDP), sold-tile `.tile-link`, and the Lightbox permalink. **This spec scopes the morph to `ProductTileLink` → PDP hero (PDP → PDP)**, the cleanest unambiguous navigation with no modal/duplicate-name issues. The lightbox-permalink morph (collection → PDP through the modal) is a documented spike finding, deferred.

### Technique (decided)

Use **Next.js's experimental `viewTransition`** (`experimental: { viewTransition: true }` in `next.config`, webpack-compatible) rather than a hand-rolled `document.startViewTransition` wrapper — because with the App Router `router.push` resolves before the new RSC route paints, so a manual wrapper can capture the wrong "after" state. Next's integration hooks the transition into the router lifecycle and avoids that.

- **Shared name:** assign `view-transition-name: product-<id>` to the `ProductTileLink` `<img>` (the navigating source) and to the PDP hero `<img>` (`ProductPageGallery`). Names are unique among simultaneously-rendered elements (one per product): on any PDP the hero is `product-<current>` and each "more from" tile is `product-<sibling>` — all distinct. **Do not** also name the `Gallery` `ProductTile` image, or an open lightbox would create a duplicate `product-<id>` at transition time.
- **Gate:** wrap in `@supports` for the CSS side; the API no-ops where unsupported → normal navigation. Under `@media (prefers-reduced-motion: reduce)`, disable the transition (`::view-transition-group/-old/-new { animation: none }` and/or skip the transition) so it collapses to an instant swap.
- **Text-stretch fix:** apply `view-transition-name` to morphing **images only**, never text; set `width: fit-content` on any text element that would otherwise distort.

### Mandatory accessibility fix

View transitions abandon focus when the active element is removed. After the transition finishes, **manually route focus to the PDP `<h1>`** (add `tabIndex={-1}`, `.focus()` in the transition-finished callback) so screen-reader users land on the new page heading, not nowhere.

### 404 preservation

The morph wraps successful client navigations only; a missing product still hits `notFound()` and returns a real 404. **No `loading.tsx` is added to `(pdp)`.** Verify this explicitly.

### OpenNext/Workers verification

The `experimental.viewTransition` flag is client-side, but confirm the production build under `npm run preview:cf` still renders and 404s correctly before merging the morph PR.

### Success metric

None of its own — C-morph is polish. It must be **conversion-neutral**: no regression to PDP→checkout after it lands (guard against layout jank or focus bugs suppressing add-to-cart).

### Risks

- **Experimental API churn** across Next minors → pin behaviour, keep the morph isolated in its own PR so a revert is trivial.
- **Focus routing missed** → screen-reader users stranded. Mitigation: the a11y fix is a hard acceptance criterion, tested.

## Out of scope for Spec C

- Prints PDP transparency (separate fulfilment/pricing path).
- Collection-page redesign (Spec B) — C-morph only *adds names* to today's tile; B preserves them.
- AR "view in room" — deferred completely.
