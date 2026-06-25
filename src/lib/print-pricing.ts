/* ============================================================
   Fine-art print pricing — server-authoritative variant prices.
   ------------------------------------------------------------
   Model: a per-size base price + per-paper / per-frame deltas. One
   source of truth: validateCart() on the server calls priceOfVariant()
   to compute what is actually charged. The client never sends a price.

   All amounts are in MAJOR units (PLN złoty / whole EUR), exactly like
   PRICE_PLN / PRICE_EUR. Conversion to minor units (grosze / euro-cents)
   happens at checkout via toGrosze() / toEuroCents().
   ============================================================ */
import type { PrintFrame, PrintPaper, PrintSize, PrintVariantSelection } from './types';

type Money = { pln: number; eur: number };

/** Base price per size (the largest cost driver). */
export const PRINT_SIZE_BASE: Record<PrintSize, Money> = {
  a4: { pln: 105, eur: 25 },
  a3: { pln: 150, eur: 35 },
  a2: { pln: 190, eur: 45 },
};

/** Surcharge per paper relative to the cheapest paper (matte). */
export const PRINT_PAPER_DELTA: Record<PrintPaper, Money> = {
  matte: { pln: 0, eur: 0 },
  satin: { pln: 0, eur: 0 },
};

/** Surcharge per frame option (none = unframed, the baseline). */
export const PRINT_FRAME_DELTA: Record<PrintFrame, Money> = {
  none: { pln: 0, eur: 0 },
  oak: { pln: 0, eur: 0 },
  black: { pln: 0, eur: 0 },
};

/**
 * Price (MAJOR units) for a chosen variant, in the order's currency.
 * This is the only place an amount-to-charge is derived; the frontend uses it
 * for display only, the server uses it for the PaymentIntent — same numbers.
 */
export function priceOfVariant(
  sel: PrintVariantSelection,
  currency: 'pln' | 'eur',
): number {
  const base = PRINT_SIZE_BASE[sel.size];
  const paper = PRINT_PAPER_DELTA[sel.paper];
  const frame = PRINT_FRAME_DELTA[sel.frame];
  return currency === 'eur'
    ? base.eur + paper.eur + frame.eur
    : base.pln + paper.pln + frame.pln;
}
