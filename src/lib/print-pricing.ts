import type { PrintDesign, PrintSize, PrintVariantSelection } from './types';

type Money = { pln: number; eur: number; gbp: number };
type Currency = keyof Money;

// Default per-size prices; premium designs override per size via
// PrintDesign.prices (e.g. the Ostrea series) so display and checkout
// always agree on the same per-design number.
const SIZE_BASE: Record<PrintSize, Money> = {
  '30x40':  { pln: 105, eur: 25, gbp: 22 },
  '50x70':  { pln: 150, eur: 35, gbp: 30 },
  '70x100': { pln: 190, eur: 45, gbp: 38 },
};

// Frame / passe-partout surcharges at 100% margin: 2× Prodigi's cost delta
// (CFP−FAP for the frame, CFPM−CFP for the mount), quoted 2026-07-03 from the
// sandbox API. EUR is the quoted figure; PLN/GBP use the same fixed conversion
// as the base tables (×4.25 / ×0.86), rounded to whole units.
const FRAMED_DELTA: Record<PrintSize, Money> = {
  '30x40':  { pln: 230, eur: 54,  gbp: 46 },  // cost delta €27.00
  '50x70':  { pln: 305, eur: 72,  gbp: 62 },  // cost delta €36.00
  '70x100': { pln: 485, eur: 114, gbp: 98 },  // cost delta €56.65
};
const MOUNT_DELTA: Record<PrintSize, Money> = {
  '30x40':  { pln: 35,  eur: 8,   gbp: 7 },   // cost delta €4.00
  '50x70':  { pln: 100, eur: 24,  gbp: 21 },  // cost delta €12.00
  '70x100': { pln: 45,  eur: 10,  gbp: 9 },   // cost delta €5.00
};

function sizePrice(design: PrintDesign, size: PrintSize): Money {
  return design.prices?.[size] ?? SIZE_BASE[size];
}

/** Price in MAJOR units (PLN złoty / EUR / GBP). Conversion to minor units at checkout. */
export function priceOfVariant(
  design: PrintDesign,
  sel: PrintVariantSelection,
  currency: Currency,
): number {
  const base = sizePrice(design, sel.size);
  const frame = sel.framed ? FRAMED_DELTA[sel.size][currency] : 0;
  const mount = sel.framed && sel.mount ? MOUNT_DELTA[sel.size][currency] : 0;
  return base[currency] + frame + mount;
}

/** Cheapest sellable price of a design — the "from X" shown on tiles. */
export function fromPriceOf(design: PrintDesign, currency: Currency): number {
  return Math.min(...design.sizes.map((s) => sizePrice(design, s)[currency]));
}
