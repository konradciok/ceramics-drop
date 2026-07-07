# 04 — Emails: print-aware customer + studio comms (Findings 5, 6, 7)

> **Severity: Medium.** F7 is a two-line select fix; F5 and F6 are the substance.
> **Effort: `high`.** **Discriminator:** `order_items.variant` (or `orders.fulfilment_type`).
>
> **Note on i18n:** email copy lives in the **`I18N_*` maps inside `src/lib/email.ts`**, not in `messages/*.json`. The "all four locales" rule still applies — add `pl`/`en`/`es`/`de` entries to the relevant in-file map.

## Goal

1. **Finding 7 (trivial):** the studio new-order email must show the print variant + SKU. The builder already supports it; the callers don't pass `variant`.
2. **Finding 5:** the customer order-confirmation email must have a **print** copy variant (Prodigi fulfilment, production time, EU/UK courier) instead of the ceramic/InPost/Poland copy.
3. **Finding 6:** print customers must get a **"shipped" email with tracking** — today only ceramics do (via the InPost webhook). Send it from the Prodigi callback on the shipped stage.

## Current state (verified)

- `src/lib/email.ts`
  - Studio: `buildNewOrderToStudioEmail({ order })` (~L222-267). `NewOrderEmailOrder.items` type **already includes** `variant?: (PrintVariantSelection & { prodigiSku }) | null` and renders variant label + SKU when present (~L246-254). **The builder is ready.**
  - Confirmation: `I18N_ORDER_CONFIRMATION` (~L536-587), `buildOrderConfirmationEmail({...})` (~L589). Copy is ceramic/InPost/Poland-specific.
  - Shipping: `buildShippingConfirmation({...})` (~L361), `emailShippingConfirmationToCustomer(...)` (~L649).
  - Idempotency: `sendEmailOnceWithClaim(...)` (~L36-84), claims `confirmation_email_sent_at` / `studio_email_sent_at` before sending.
- **Caller gaps:**
  - Studio caller in `src/app/api/stripe/webhook/route.ts` (~L223-226) selects `order_items(product_id, unit_price)` — **no `variant`**.
  - Same in `scripts/reconcile-orders.mjs` (~L638-641): `select('product_id, unit_price')`.
- `src/server/prodigi/callbacks.ts` → `handleProdigiCallback(body, env)` (~L20-169): on a status update it upserts `prodigi_orders` with the new stage + `prodigi_raw_json` (which holds `shipments` incl. tracking) but **sends no customer email**.
- `src/server/fulfilment/status-map.ts` → `mapProdigiStage`: `Complete → shipped`.

## Approach

### Finding 7 — pass `variant` + SKU to the studio email

In the webhook studio caller **and** `scripts/reconcile-orders.mjs`, add `variant` to the `order_items` select, and map each print item to `{ ...variant, prodigiSku }` using `PRODIGI_SKU_MAP[variantKey(variant)]` (from `src/lib/print-cart.ts`) before passing to `buildNewOrderToStudioEmail`. Ceramic items pass `variant: null` (unchanged rendering).

### Finding 5 — print confirmation copy

Give `buildOrderConfirmationEmail` a **print** branch selected by the order's kind (all items `variant !== null`). Add a parallel `I18N_ORDER_CONFIRMATION` variant (or a `kind`-keyed sub-map) with print-appropriate copy in **all four locales**: fulfilment by Prodigi, expected production time, courier delivery across EU/UK, no InPost/Poland/locker references. The webhook confirmation caller (guarded by `confirmation_email_sent_at` via `sendEmailOnceWithClaim`) passes the kind so the right copy is chosen. Ceramic copy stays exactly as-is.

### Finding 6 — Prodigi shipping/tracking email

In `handleProdigiCallback`, when the stage transitions to `Complete`/`shipped`:
- extract tracking from the Prodigi order's `shipments[]` (carrier + tracking number/url) out of `prodigi_raw_json` / the callback body;
- send a shipping-confirmation email (a **print** variant of `buildShippingConfirmation`, or reuse it with Prodigi tracking fields);
- guard it **claim-once** so a replayed callback doesn't re-send. Add a claim column — e.g. `prodigi_orders.shipping_email_sent_at` (migration, timestamp) — and use the same claim-before-send pattern as `sendEmailOnceWithClaim`.

Prints ship to an EU/UK home address, so the copy must be courier/tracking-oriented (no locker language).

## Acceptance criteria

- [ ] Studio new-order email for a print order shows each item's size/frame/mount label **and** its Prodigi SKU (both webhook and `reconcile-orders`).
- [ ] Customer confirmation for a **print-only** order uses print copy (Prodigi, production time, EU/UK courier) — no InPost/Poland/locker text — in all four locales.
- [ ] Customer confirmation for a ceramic order is unchanged.
- [ ] On the Prodigi `Complete`/`shipped` stage, the customer gets one shipping email with tracking; a replayed callback sends **zero** additional emails (claim-once).
- [ ] Ceramic shipping email (InPost webhook) is unchanged and still only fires for ceramics.

## Tests

- `src/lib/email.ts` builders: unit/snapshot for the **print** confirmation variant and for `buildNewOrderToStudioEmail` with a print item (asserts SKU + variant label appear).
- `src/app/api/stripe/webhook/route.test.ts` (extend): studio-email payload for a print order includes `variant` + SKU.
- `src/server/prodigi/callbacks.test.ts` (**new** — see `07`): `Complete` stage sends the tracking email once; replay sends none (claim-once).

Run: `npx vitest run src/lib/email.test.ts src/app/api/stripe/webhook/route.test.ts src/server/prodigi/callbacks.test.ts`, then `npm run lint && npm run build`.

## Boundaries

- Reuse `sendEmailOnceWithClaim` / the claim-column pattern — don't invent a new idempotency mechanism.
- Don't restructure the ceramic email paths; add print branches alongside them.
- Keep all new copy in the `email.ts` `I18N_*` maps across all four locales.
