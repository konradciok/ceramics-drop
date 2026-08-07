import type { PrintDesign, PrintSize, PrintVariantSelection } from './types';

type Currency = 'pln' | 'eur' | 'gbp';

/**
 * The one global fine-art-print price list. EUR is canonical: the admin edits
 * the 9 EUR values plus the two conversion rates at /admin/pricing (persisted
 * in the single-row `print_pricing_config` table); PLN and GBP are derived
 * per component by `derivePrice`. All prints share this config — there is no
 * per-design pricing.
 */
export interface PrintPricingConfig {
  /** Unframed price per size, whole EUR. */
  baseEur: Record<PrintSize, number>;
  /** Frame surcharge per size, whole EUR — identical for every frame colour. */
  frameEur: Record<PrintSize, number>;
  /** Passe-partout surcharge per size, whole EUR — only applied on framed variants. */
  mountEur: Record<PrintSize, number>;
  eurToPln: number;
  eurToGbp: number;
}

/**
 * Code fallback + migration seed twin. Used when CATALOG_SOURCE=code
 * (local/tests) and when the DB read fails; keep in lockstep with the seed
 * row in supabase/migrations/20260807120000_print_pricing_config.sql and
 * with any permanent price change made in /admin/pricing.
 */
export const DEFAULT_PRINT_PRICING: PrintPricingConfig = {
  baseEur: { '30x40': 25, '50x70': 50, '70x100': 75 },
  frameEur: { '30x40': 35, '50x70': 35, '70x100': 35 },
  mountEur: { '30x40': 25, '50x70': 25, '70x100': 25 },
  eurToPln: 4.25,
  eurToGbp: 0.86,
};

/**
 * Convert one EUR price component into the display currency. PLN rounds to
 * the nearest 5 zł, GBP to the nearest 1 £. The intermediate round-to-cents
 * step keeps IEEE noise out of the half-way cases (25 × 0.86 must be 21.5,
 * not 21.4999…, so it rounds up to 22).
 */
export function derivePrice(eur: number, currency: Currency, config: PrintPricingConfig): number {
  if (currency === 'eur') return eur;
  const rate = currency === 'pln' ? config.eurToPln : config.eurToGbp;
  const raw = Math.round(eur * rate * 100) / 100;
  return currency === 'pln' ? Math.round(raw / 5) * 5 : Math.round(raw);
}

/**
 * Price in MAJOR units (PLN złoty / EUR / GBP); conversion to minor units at
 * checkout. Pure and sync — callers resolve the config (server: via
 * getPrintPricingConfig(); client components: via a prop from their page).
 * Derivation is component-wise (base/frame/mount each converted+rounded,
 * then summed) so displayed component prices always add up.
 */
export function priceOfVariant(
  sel: PrintVariantSelection,
  currency: Currency,
  config: PrintPricingConfig,
): number {
  const base = derivePrice(config.baseEur[sel.size], currency, config);
  const frame = sel.framed ? derivePrice(config.frameEur[sel.size], currency, config) : 0;
  const mount = sel.framed && sel.mount ? derivePrice(config.mountEur[sel.size], currency, config) : 0;
  return base + frame + mount;
}

/** Cheapest sellable price of a design — the "from X" shown on tiles. */
export function fromPriceOf(
  design: PrintDesign,
  currency: Currency,
  config: PrintPricingConfig,
): number {
  return Math.min(...design.sizes.map((s) => derivePrice(config.baseEur[s], currency, config)));
}
