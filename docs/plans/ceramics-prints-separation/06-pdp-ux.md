# 06 — PDP/UX: mirror the mixed-cart guard + PL-only message + shipping note (Findings 10, 13)

> **Severity: Low.** Small UX consistency fixes. Most of the real protection is the server block (kept) and the E2E specs in `07`.
> **Effort: `medium`.**

## Goal

1. **Finding 10:** the ceramic **add-to-cart** button must refuse (or warn) when a print is already in the cart — mirroring the guard the print configurator already has. Today the mix is only caught in the cart view and server-side, so the user learns about the conflict too late.
2. **Companion to Finding 10 (settled Q7):** show an explicit "ceramics ship to Poland only" message where the ceramic courier/country choice is made, so foreign buyers aren't left guessing why there's no country selector.
3. **Finding 13:** flat print shipping under-charges multi-frame orders — **no code change** (settled). Add a monitoring note so the gap is observable.

## Current state (verified)

- Print PDP: `src/components/shop/PrintConfigurator.tsx` — `cartHasCeramics = ids.some((id) => !isPrintToken(id))` (~L47); blocks add + shows `print.mixedCart` note when `cartHasCeramics && !inCart` (~L167-173). **Has the guard.**
- Ceramic PDP: `src/components/shop/AddToCartButton.tsx` (~L19-53) — only checks `product.sold` and cart membership. **No print-awareness.** The mix is only caught later in `CartView` (`cart.mixedNotice`) and server `validateCart`.
- `src/lib/print-shipping.ts` (~L23-24): existing `ponytail:` comment already documents the flat-rate trade-off.

## Approach

### Finding 10 — mirror the guard on `AddToCartButton`

Add print-awareness symmetric to `PrintConfigurator`: read the cart tokens, compute `cartHasPrints = ids.some(isPrintToken)`, and when true (and this ceramic isn't already in the cart) disable the add and show a mixed-cart notice. Reuse the existing mixed-cart message key (`cart.mixedNotice` or the same key `PrintConfigurator` uses) — add locale copy only if a PDP-specific string is genuinely needed (all four locales if so).

### Q7 — "ceramics ship to PL only" message

In the ceramic delivery section (in `CartView` where the courier/address is chosen — the ceramic address is hardcoded to PL), add a short informational line: ceramics ship only to addresses in Poland. New copy in **all four** `messages/*.json` locales. This is copy only — no logic change to the PL enforcement (which already lives server-side).

### Finding 13 — monitoring only

No code change to the flat rate. Keep the `ponytail:` comment. Optionally add a cheap signal — e.g. log/annotate when a print order contains more than one framed item — so the quote-vs-charged gap is observable in prod without changing pricing. Record the "revisit with `POST /quotes` when margins show the gap hurts" trigger in `PROGRESS.md` and, if useful, a one-line note near the pricing code.

## Acceptance criteria

- [ ] With a print in the cart, the ceramic PDP add-to-cart is disabled/blocked with a mixed-cart notice (symmetry with the print PDP).
- [ ] With only ceramics (or an empty cart), the ceramic add-to-cart behaves exactly as before.
- [ ] The ceramic delivery UI shows a "ships to Poland only" message, present in all four locales.
- [ ] No change to print shipping amounts; the multi-frame trade-off is documented/observable.

## Tests

- Client-component unit tests may not exist in this repo; the mixed-cart guard is primarily proven by the **`e2e/mixed-cart.spec.ts`** spec in `07`. If a lightweight test harness for `AddToCartButton` exists, add a guard test; otherwise rely on the E2E spec and note that in `PROGRESS.md`.

Run: `npm run lint && npm run build` (and `npm run test` for any unit test added).

## Boundaries

- Do not change the server-side PL enforcement or the mixed-cart server block — this is UI mirroring only.
- Do not change print shipping prices under Finding 13.
- Reuse existing message keys where possible; only add new copy when necessary, and then in all four locales.
