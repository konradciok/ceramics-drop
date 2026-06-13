/* ============================================================
   Fine-art print pricing — server-authoritative variant prices.
   ------------------------------------------------------------
   Model: a per-size base price + per-paper / per-frame deltas, with
   an optional full-amount override per (designId, variantKey). One
   source of truth: validateCart() on the server calls priceOfVariant()
   to compute what is actually charged. The client never sends a price.

   All amounts are in MAJOR units (PLN złoty / whole EUR), exactly like
   PRICE_PLN / PRICE_EUR. Conversion to minor units (grosze / euro-cents)
   happens at checkout via toGrosze() / toEuroCents().

   ⚠️ Figures below are PLACEHOLDERS pending studio confirmation of the
   real size / paper / frame options and prices (see plan "Otwarte pytania").
   ============================================================ */
import type { PrintFrame, PrintPaper, PrintSize, PrintVariantSelection } from './types';

type Money = { pln: number; eur: number };

/** Base price per size (the largest cost driver). */
export const PRINT_SIZE_BASE: Record<PrintSize, Money> = {
  a4: { pln: 120, eur: 29 },
  a3: { pln: 180, eur: 43 },
  a2: { pln: 260, eur: 62 },
};

/** Surcharge per paper relative to the cheapest paper (matte). */
export const PRINT_PAPER_DELTA: Record<PrintPaper, Money> = {
  matte: { pln: 0, eur: 0 },
  satin: { pln: 20, eur: 5 },
};

/** Surcharge per frame option (none = unframed, the baseline). */
export const PRINT_FRAME_DELTA: Record<PrintFrame, Money> = {
  none: { pln: 0, eur: 0 },
  oak: { pln: 150, eur: 36 },
  black: { pln: 150, eur: 36 },
};

/**
 * Optional full-amount override per `${designId}:${variantKey}` (NOT a delta).
 * Lets a single design/variant escape the base+delta model when needed.
 * Mutable map kept intentionally simple; populated in code, no DB.
 */
export const PRINT_PRICE_OVERRIDE: Record<string, Money> = {};

/** Currency-agnostic key for an override lookup. */
function overrideKey(designId: string, sel: PrintVariantSelection): string {
  return `${designId}:${sel.size}:${sel.paper}:${sel.frame}`;
}

/**
 * Price (MAJOR units) for a design's chosen variant, in the order's currency.
 * This is the only place an amount-to-charge is derived; the frontend uses it
 * for display only, the server uses it for the PaymentIntent — same numbers.
 */
export function priceOfVariant(
  design: { id: string },
  sel: PrintVariantSelection,
  currency: 'pln' | 'eur',
): number {
  const override = PRINT_PRICE_OVERRIDE[overrideKey(design.id, sel)];
  if (override) return currency === 'eur' ? override.eur : override.pln;

  const base = PRINT_SIZE_BASE[sel.size];
  const paper = PRINT_PAPER_DELTA[sel.paper];
  const frame = PRINT_FRAME_DELTA[sel.frame];
  return currency === 'eur'
    ? base.eur + paper.eur + frame.eur
    : base.pln + paper.pln + frame.pln;
}
