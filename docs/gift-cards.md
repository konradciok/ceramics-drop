# Gift cards

Backend/domain + customer-facing reference for the gift-card feature (backend
2026-09-04, PDP/checkout 2026-09-04). It complements `docs/promo-codes.md`, which this
feature reuses heavily. The customer-facing PDP + dedicated checkout (§"PDP + checkout
— built 2026-09-04" below) are implemented and buyable end to end; this doc is now a
reference for anyone modifying either half.

## What exists today

- 4 fixed denomination tiers, no custom amount. Buyable at `/karta-podarunkowa` (all 4
  locales), linked from the footer and mobile nav — see the PDP section below for what
  was built and the UX calls made building it.
- Everything described below is real, tested, and typechecked.

## Decisions already made (do not re-litigate without checking with the operator)

- 4 tiers: 200 / 500 / 1000 / 2000 zł ≈ 50 / 120 / 250 / 500 € ≈ £40 / £100 / £200 / £400.
- Redeemable everywhere (ceramics + prints) — `applies_to: 'all'` on the minted code.
- Buyer always receives the code themselves. No recipient form, no delivery address.
- **Schema = Option A**: a paid gift-card order mints a single-use `promo_codes` row
  (fixed kind, `max_redemptions: 1`) instead of a bespoke balance ledger. The code's
  value is clamped to a future cart's subtotal exactly like any fixed promo — **any
  excess over that cart is forfeited, not carried forward or refunded.** This must be
  stated in the PDP's terms copy.
- Gift cards are their own exclusive cart/order track: cannot mix with ceramics or
  prints in one order, no shipping, no piece reservation.

## Decisions made *during the backend build* that weren't specified upstream

These were reasonable calls made to ship a coherent backend contract — reconsider if
the PDP's actual UX conflicts with them:

1. **At most one gift-card line per checkout.** The cart is a `Set<string>` of tokens,
   so a buyer *can* add two different tiers to the cart at once; `validateCart` rejects
   that (`reason: 'multiple_gift_cards'`) because Option A mints exactly one
   `promo_codes` row per order (`source_order_id` is unique). Buying several gift cards
   means several separate checkouts. If the PDP wants a quantity selector, that needs a
   deliberate schema change (multiple mints per order), not a quiet workaround.
2. **No promo codes on a gift-card purchase.** Checkout 400s
   (`{ error: 'invalid_promo', reason: 'wrong_track' }`) if a promo code is submitted
   alongside a gift-card cart — a discount on the *purchase* combined with the minted
   code always being the tier's full face value is a straightforward arbitrage the
   existing no-stacking promo design was never meant to cover.
3. **Contact only, no delivery form.** `validateGiftCardContact()` requires
   `first_name` / `last_name` / `email` (phone optional, never required) and nothing
   else — no address, no delivery method. Checkout stores `delivery_method` /
   `shipping_method` as `'odbior'` (reusing the existing "no shipment" value — it
   already prices shipping at 0 in every currency and needs no address) but the *real*
   discriminator for downstream logic is `orders.fulfilment_type = 'giftcard'`.
4. **Delivery email doubles as the "confirmation".** The dedicated gift-card email
   (code + amount, styled as a printable "card") is sent instead of the standard
   order-confirmation email, not in addition to it — the standard copy talks about
   shipping/production, which makes no sense for a gift card. It reuses the
   `orders.confirmation_email_sent_at` claim column (gift-card orders never trigger the
   standard confirmation email, so there's no conflict).
5. **"Printable card" = styled HTML email, not a generated asset.** No PDF/image
   generation infrastructure was built — the email is a self-contained, print-friendly
   HTML document (a dark "card" block with the amount + code in large text). A viewer
   can use their browser/mail client's "print" or "save as PDF". Revisit if the
   operator wants an actual downloadable asset later.
6. **No expiry.** `starts_at`/`expires_at` are `null` on a minted code (unlimited),
   since nothing in the brief specified an expiry window.
7. **Studio gets no dedicated "gift card sold" notification beyond the existing
   generic new-paid-order email** (`emailNewOrderToStudio`, already fixed to label a
   gift-card line item correctly instead of mislabeling it as a print).
8. **`CartView.tsx`** (the existing ceramics/prints cart page) filters gift-card lines
   out of what it renders — it has no concept of the gift-card track. A gift-card
   purchase needs its own flow (dedicated mini-cart/checkout on the PDP, or reusing
   `CartView` after real UI work) — that's this feature's `PROCESS`/scope boundary,
   deliberately left to the PDP build.

## The domain module: `src/lib/gift-cards.ts`

This is the contract the PDP should import from — treat the exported surface as
stable:

```ts
// Tiers
export type GiftCardTierId = 'gc-200' | 'gc-500' | 'gc-1000' | 'gc-2000';
export interface GiftCardTier { id: GiftCardTierId; amountPln: number; amountEur: number; amountGbp: number; }
export const GIFT_CARD_TIERS: readonly GiftCardTier[];
export function getGiftCardTier(id: string): GiftCardTier | null;
export function isGiftCardTierId(id: string): id is GiftCardTierId;
export function giftCardAmountMajor(tier: GiftCardTier, currency: Currency): number;
export function formatGiftCardAmount(tier: GiftCardTier, currency: 'pln'|'eur'|'gbp'): string; // "500 zł"

// Cart token — mirrors print-cart.ts's `print:` pattern
export function isGiftCardToken(id: string): boolean;
export function encodeGiftCardToken(tierId: GiftCardTierId): string; // "giftcard:gc-500"
export function decodeGiftCardToken(token: string): { tierId: GiftCardTierId } | null;

// Resolve a token to a priced line (checkout currency, minor units)
export interface GiftCardLine { tierId: GiftCardTierId; tier: GiftCardTier; unitPriceMinor: number; }
export function resolveGiftCardToken(token: string, currency: 'pln'|'eur'|'gbp'): GiftCardLine | null;

// order_items.variant snapshot shape (jsonb) — NULL still means "ceramic",
// { kind: 'print', ... } is the existing print shape.
export interface GiftCardOrderItemVariant { kind: 'giftcard'; tierId: GiftCardTierId; }
export function isGiftCardOrderItemVariant(v: unknown): v is GiftCardOrderItemVariant;

// Buyer contact — no address, no delivery method
export interface GiftCardContact { first_name: string; last_name: string; email: string; phone: string | null; }
export function validateGiftCardContact(raw: unknown):
  | { ok: true; contact: GiftCardContact }
  | { ok: false; reason: 'invalid_contact' };

// Minting (Option A) — pure builder, no I/O. The webhook route does the actual insert.
export interface MintedGiftCardPromoRow { /* a promo_codes insert payload */ }
export function generateGiftCardCode(randomBytes?: (n: number) => Uint8Array): string; // "GIFT-7K3P9QRT"
export function buildGiftCardPromoRow(params: { tier: GiftCardTier; orderId: string; code?: string }): MintedGiftCardPromoRow;
```

`src/lib/cart-lines.ts` (client-safe, used by the storefront cart UI) resolves a
gift-card token into `{ kind: 'giftcard'; id: string; tier: GiftCardTier }`, alongside
the existing `ceramic` and `print` kinds.

## Checkout (`src/app/api/checkout/route.ts`)

A gift-card cart (detected via `valid.items.some(i => i.giftCardTierId != null)`):

- Skips `validateDelivery` / `validatePrintDelivery` entirely — only
  `validateGiftCardContact(body)` runs.
- Skips `reserve_pieces()` entirely (`ceramicIds` excludes gift-card items).
- Rejects a promo code (`invalid_promo` / `wrong_track`) and a private-sale token
  (`private_sale_giftcards_unsupported`).
- Charges the tier's exact price in the checkout currency, with `shipping: 0`.
- Writes `orders.fulfilment_type = 'giftcard'`, `order_items.variant = { kind:
  'giftcard', tierId }`.
- Stamps PaymentIntent metadata `has_gift_cards: '1'`, `gift_card_tier: <tierId>`.

## Webhook fulfilment (`src/app/api/stripe/webhook/route.ts`)

`WebhookDeps.fulfilGiftCard(paymentIntentId)` runs on every `payment_intent.succeeded`
delivery (mirrors `trackPurchase`'s always-runs idempotency idiom), right after
`markPaid`:

1. No-ops for any non-gift-card order, or one not yet `paid`.
2. Mints the code via `buildGiftCardPromoRow()` + a plain `promo_codes` insert.
   Idempotent via the unique index on `promo_codes.source_order_id`
   (`supabase/migrations/20260904120000_gift_card_promo_codes.sql`) — a 23505 on
   redelivery means "already minted", so it re-fetches the existing code instead of
   erroring.
3. Sends `emailGiftCardToCustomer()` (`src/lib/email.ts`), claimed once via
   `orders.confirmation_email_sent_at` (safe to reuse: the standard order-confirmation
   email is skipped entirely for gift-card orders — see decision 4 above).
4. Best-effort throughout: a failure here Sentry-alerts but never throws, so a
   mint/email hiccup can't turn into a Stripe retry storm on an already-captured
   payment. **There is no CLI/admin resend helper yet** for a stuck gift-card
   email — a manual `promo_codes` read + a manual Resend send is the only recovery path
   today.

`createShipment` (same route) returns immediately for any order whose line items are
gift-card-shaped — no InPost shipment, no Prodigi enqueue.

## Refunds

`releaseSale`'s paid→refunded branch (and its already-refunded crash-resume branch)
calls `revokeGiftCardCode(supabase, orderId)` — a plain
`UPDATE promo_codes SET active = false WHERE source_order_id = $1 AND source =
'gift_card'`. No new RPC: revocation reuses the same `active` flag
`checkPromoEligibility` already gates on. This does **not** claw back a redemption
that already happened on a *different* order before the refund — accepted edge case,
matches the promo-codes feature's existing no-clawback stance on a refunded-after-paid
order.

## Admin (`/admin/promotions`)

Purchase-minted codes (`promo_codes.source = 'gift_card'`, `source_order_id` set) are
visually flagged in the table (a "karta podarunkowa" pill) and are **read-only**
except the Aktywuj/Dezaktywuj toggle — `updatePromotion()` 400s
(`gift_card_code_readonly`) on any other field change. The `PromoCode` TypeScript type
(`src/lib/promo.ts`) now carries `source: 'admin' | 'gift_card'` and
`source_order_id: string | null`; every existing row defaults to `source: 'admin'`
with a null `source_order_id`, so the existing promo-codes feature is unaffected in
shape or behaviour.

## Database

`supabase/migrations/20260904120000_gift_card_promo_codes.sql` — purely additive:

- `promo_codes.source text not null default 'admin' check (source in ('admin',
  'gift_card'))`
- `promo_codes.source_order_id uuid references orders (id)`, unique partial index
  where not null (the mint-once guarantee)
- `orders.fulfilment_type` CHECK widened to include `'giftcard'`

A pgTAP test lives at `supabase/tests/gift_card_promo_codes.sql` (mirrors the existing
`supabase/tests/private-sale.sql` pattern) — **not executed against any live/remote
project**; run it locally with `supabase test db` before trusting the migration
against a real database.

## PDP + checkout — built 2026-09-04

Everything below is implemented, translated (pl/en/es/de), tested (`npm run
lint && npm run typecheck && npm run test` green), and wired into nav/footer.
It is the customer-facing half described in "What the PDP agent still needed
to build" — kept below in git history for anyone diffing, but the section
itself is superseded by this one.

- **Route:** `/karta-podarunkowa` (all 4 locales — no `pathnames` mapping in
  `src/i18n/routing.ts`, so every locale shares the Polish slug, exactly like
  `/o-studiu` and `/dostawa-i-zwroty`). `src/app/[locale]/karta-podarunkowa/page.tsx` →
  `src/components/shop/GiftCardScreen.tsx` (server) → `GiftCardConfigurator.tsx`
  (client island). `force-dynamic` — not for the static tiers, but because the
  About-the-Artist band is read from the live-editable `page:print-pdp` CMS
  document (reused as-is; no dedicated gift-card CMS document was added).
- **Tier picker:** `GIFT_CARD_TIERS` rendered as a `print-opt` radio group
  (reusing the print-PDP's CSS, not new markup) — no per-tier translation
  needed, `formatGiftCardAmount` is currency-native. Picking a different tier
  replaces the selection (no quantity stepper), matching the "at most one
  gift-card line per checkout" backend constraint.
- **Checkout flow — dedicated, NOT `CartView.tsx`.** Decision: build a
  self-contained checkout inside `GiftCardConfigurator.tsx` (pick tier → buy →
  contact form → Stripe PaymentElement) rather than extending `CartView.tsx`.
  Reasoning: a gift-card order is always exactly one item, needs a materially
  different (shorter, no-address) form, can never mix with anything else in
  the cart, and `CartView.tsx` already actively *filters gift-card tokens
  out* (decision 8) — un-filtering it and threading a parallel no-shipping/
  no-promo/no-mixed-cart code path through its ~1000-line, deeply stateful
  component would have been far riskier than a small dedicated island. The
  gift-card token is never written to the persisted Zustand cart store — the
  configurator calls `POST /api/checkout` directly with `ids: ['giftcard:<tier>']`
  and its own `contact` object, mirroring `CartView`'s attempt-id /
  409-handling contract (`checkout-client.ts`'s `shouldKeepAttemptIdOnCatch` /
  `checkoutPreBodyError`) but only the subset that actually applies (no
  delivery, no promo, no private-sale, no mixed-cart 409).
- **Stripe / return page reuse — no new payment surface.** The Stripe
  `Elements` + `CheckoutForm` (`src/components/shop/CheckoutForm.tsx`) are
  reused unmodified. `return_url` points at the *existing* `/koszyk/return`
  page, unmodified: `analyticsItemForId` (`src/lib/analytics.ts`) was taught to
  resolve `giftcard:` tokens, so the return page's generic
  `pushConfirmedPurchaseFromRememberedCheckout` → `analyticsItemsForIds` path
  fires the `purchase` event for a gift-card order exactly like it does for
  ceramics/prints, with zero return-page changes. `clear()` on that page wipes
  the (never-touched) ceramics/prints cart — harmless no-op for a gift-card
  purchase.
- **Analytics:** `buildGiftCardAddToCartEvent` / `buildGiftCardViewItemEvent`
  added to `src/lib/analytics.ts` (mirror the `buildPrint*` builders;
  `item_category: 'gift-card'`, `item_id` = tier id so it's currency-stable).
  `add_to_cart` fires when "Buy" is clicked (tier → contact step); `begin_checkout`
  fires via the existing `pushCheckoutStartedItemsOnce` on contact-form submit;
  `purchase` fires via the reused return-page path above; `view_item` fires once
  on mount for parity with the print PDP (not required by spec, added for
  consistency).
- **Terms copy:** two static (translated, not CMS-driven) `PdpAccordions`
  entries — "How it works" and "Terms" — the latter explicitly states the
  forfeit-on-excess policy, no expiry, and that the code is entered via the
  existing "I have a promo code" cart field (`messages/*.json` → `giftCard.accordionTermsBody` / `accordionHowBody`).
- **Nav/footer:** added last, after the flow was verified end-to-end (lint +
  typecheck + unit tests; a full dev-server click-through was blocked by a
  pre-existing worktree `.next` symlink issue — see `MEMORY.md`
  `footer-pstr-redesign.md` — unrelated to this feature). Footer: new
  "Karta podarunkowa" link in the Malarstwo/Art section (`footer.hArt`),
  alongside Fine Art Prints / Gallery / Cart. Mobile menu: added between Fine
  Art Prints and Showroom. **Deliberately left off the desktop `.nav-left`**
  bar (`Header.tsx`) — that row is already five items wide and a gift card is
  a secondary/support purchase, not a primary browsing category; footer +
  mobile menu give it real discoverability without crowding the primary nav.
  Revisit if conversion data says it needs more prominence.
- **Redemption UI:** none added — as documented above, the existing
  `cart.promo.have` input on `CartView.tsx` already redeems a minted
  gift-card code exactly like any other promo code.
- **SEO:** added to `SITE_PATHS` (`src/lib/site.ts`) so it's sitemapped and
  indexable, with real `generateMetadata` (title/description/hreflang). No
  `Product` JSON-LD — a gift card doesn't fit that schema meaningfully and
  wasn't in scope; revisit if search performance data suggests it's worth it.
- **CSS:** new `.giftcard-*` classes in `src/styles/site.css`, but the tier
  picker / price / accordions all reuse the existing `.print-opt` / `.print-price`
  / `.pdp-accordions` classes rather than inventing parallel styling.
