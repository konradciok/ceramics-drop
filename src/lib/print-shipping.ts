/* ============================================================
   Print shipping — Prodigi fulfils prints, so print carts charge
   Prodigi's shipping cost (no InPost involvement, no margin).
   ------------------------------------------------------------
   Costs are EUR, quoted 2026-07-03 from the Prodigi sandbox API
   (POST /quotes, shippingMethod Budget) for the largest size:
   framed = GLOBAL-CFP-28X40, loose print = GLOBAL-FAP-28X40.
   Re-run the quotes when the SKU set or Prodigi rates change.
   ============================================================ */

/** Destinations we ship prints to: EU members + UK. */
export const PRINT_COUNTRIES = [
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
  'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
  'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'GB',
] as const;
export type PrintCountry = (typeof PRINT_COUNTRIES)[number];

export function isPrintCountry(code: string): code is PrintCountry {
  return (PRINT_COUNTRIES as readonly string[]).includes(code);
}

// ponytail: flat per order — a multi-frame order costs Prodigi more than one
// quote; switch to live POST /quotes per cart if that gap starts to hurt.
const SHIPPING_EUR: Record<PrintCountry, { framed: number; loose: number }> = {
  AT: { framed: 17.25,  loose: 10.45 },
  BE: { framed: 12.95,  loose: 10.45 },
  BG: { framed: 25.90,  loose: 10.45 },
  HR: { framed: 25.90,  loose: 10.45 },
  CY: { framed: 132.43, loose: 10.45 },
  CZ: { framed: 17.25,  loose: 10.45 },
  DK: { framed: 20.50,  loose: 9.15 },
  EE: { framed: 32.35,  loose: 11.62 },
  FI: { framed: 25.90,  loose: 11.62 },
  FR: { framed: 16.15,  loose: 9.15 },
  DE: { framed: 12.95,  loose: 7.30 },
  GR: { framed: 25.90,  loose: 10.45 },
  HU: { framed: 25.90,  loose: 10.45 },
  IE: { framed: 18.35,  loose: 10.25 },
  IT: { framed: 18.35,  loose: 11.62 },
  LV: { framed: 31.30,  loose: 10.45 },
  LT: { framed: 32.35,  loose: 13.45 },
  LU: { framed: 15.10,  loose: 10.45 },
  MT: { framed: 132.43, loose: 10.45 },
  NL: { framed: 11.85,  loose: 10.45 },
  PL: { framed: 18.35,  loose: 10.45 },
  PT: { framed: 25.90,  loose: 11.30 },
  RO: { framed: 23.75,  loose: 10.45 },
  SK: { framed: 25.90,  loose: 10.45 },
  SI: { framed: 25.90,  loose: 10.45 },
  ES: { framed: 25.90,  loose: 11.30 },
  SE: { framed: 19.40,  loose: 10.45 },
  GB: { framed: 20.79,  loose: 5.66 },
};

// Same fixed conversion the hand-set price tables use (see print-pricing.ts).
const EUR_TO_PLN = 4.25;
const EUR_TO_GBP = 0.86;

/**
 * Print-order shipping in MAJOR units for the display currency, rounded up to
 * a whole unit. `framed` = the cart contains at least one framed print.
 */
export function printShippingOf(
  country: PrintCountry,
  framed: boolean,
  currency: 'pln' | 'eur' | 'gbp',
): number {
  const eur = SHIPPING_EUR[country][framed ? 'framed' : 'loose'];
  if (currency === 'eur') return Math.ceil(eur);
  if (currency === 'gbp') return Math.ceil(eur * EUR_TO_GBP);
  return Math.ceil(eur * EUR_TO_PLN);
}
