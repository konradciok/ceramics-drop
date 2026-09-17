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

/** The EUR-per-order price table shape: one framed/loose pair per destination. */
export type InternationalShippingRates = Record<PrintCountry, { framed: number; loose: number }>;

// ponytail: flat per order — a multi-frame order costs Prodigi more than one
// quote; switch to live POST /quotes per cart if that gap starts to hurt.
//
// NEVER DELETE. As of the CmsApi /v1/shipping-rates cutover
// (supabase/migrations/20260917150000_cms_api_shipping_rates.sql) these values
// are ALSO the seed of the `international` resource's published revision 1 —
// src/server/cms-api/shipping-rates-mapping.test.ts parses that migration and
// fails CI if the two ever disagree — and, re-exported as
// DEFAULT_INTERNATIONAL_SHIPPING below, they remain the outage/code-mode
// fallback src/lib/shipping-rates/last-known-good.ts degrades to. That is the
// same role DEFAULT_PRINT_PRICING plays for print pricing.
const SHIPPING_EUR: InternationalShippingRates = {
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

/**
 * The code-mode / outage fallback table, under the name the shipping-rates
 * resilience layer refers to it by (src/lib/shipping-rates/{get,last-known-good}.ts).
 * Deliberately an alias rather than a rename: SHIPPING_EUR above stays exactly
 * as it was so the constant the storefront has always shipped is untouched.
 */
export const DEFAULT_INTERNATIONAL_SHIPPING: InternationalShippingRates = SHIPPING_EUR;

// Fallback conversion — used only when no config rates are supplied. The
// authoritative rates are the admin-editable `eurToPln`/`eurToGbp` on the
// print pricing config (see print-pricing.ts); callers that have the config
// (checkout, cart) must pass it so shipping converts at the same rates the
// item prices use.
const EUR_TO_PLN = 4.25;
const EUR_TO_GBP = 0.86;

/** The conversion-rate subset of PrintPricingConfig print shipping needs. */
export interface PrintShippingRates {
  eurToPln: number;
  eurToGbp: number;
}

/**
 * Print-order shipping in MAJOR units for the display currency, rounded up to
 * a whole unit (shipping never undercharges on rounding, unlike item prices).
 * `framed` = the cart contains at least one framed print. Pass `rates` from
 * the print pricing config whenever available so shipping and item prices
 * share the admin-editable conversion rates.
 *
 * `table` overrides the EUR price table with the CMS-published one — checkout
 * passes src/lib/shipping-rates/get.ts's DB-backed table; every display
 * surface (cart, PDP, feed, structured data) keeps the code constants. Note
 * that `rates` (eurToPln/eurToGbp) is deliberately NOT part of `table`: the FX
 * rates have exactly one source of truth, the print pricing config, and the
 * shipping-rates resource must never carry a second copy of them.
 */
export function printShippingOf(
  country: PrintCountry,
  framed: boolean,
  currency: 'pln' | 'eur' | 'gbp',
  rates?: PrintShippingRates,
  table: InternationalShippingRates = SHIPPING_EUR,
): number {
  const eur = table[country][framed ? 'framed' : 'loose'];
  if (currency === 'eur') return Math.ceil(eur);
  if (currency === 'gbp') return Math.ceil(eur * (rates?.eurToGbp ?? EUR_TO_GBP));
  return Math.ceil(eur * (rates?.eurToPln ?? EUR_TO_PLN));
}
