import { getProductById, getProducts } from './products';
import { getPrintById, isVariantAvailable, skuOf } from './prints';
import { decodePrintToken, isPrintToken } from './print-cart';
import { priceOfVariant } from './print-pricing';
import { PRICE_EUR, toEuroCents, toGrosze } from './pricing';
import type { PrintVariantSelection } from './types';

// Hard sanity bound: ceramics are one-of-a-kind (≤ whole catalogue), but prints
// are reproducible and a buyer may add several variants, so add headroom on top
// of the ceramic count. Derived so the ceramic part can't drift on a catalogue change.
export const MAX_CART = getProducts().length + 50;

/** A resolved print variant persisted on the order line (null/absent for ceramics). */
export type CheckoutVariant = PrintVariantSelection & { sku: string };
export type CheckoutItem = { product_id: string; unit_price: number; variant?: CheckoutVariant };
export type ValidateResult =
  | { ok: true; items: CheckoutItem[] }
  | { ok: false; reason: 'empty' | 'too_many' | 'unknown' };

/**
 * Resolve raw cart ids to deduped, catalog-known items with SERVER-COMPUTED prices.
 * Two shapes share the flat id list:
 *   - bare id (`k01`)                        → one-of-a-kind ceramic, price from PRICE_PLN/EUR
 *   - token (`print:<id>:<size>:<paper>:<frame>`) → print variant, price from priceOfVariant
 * The client never sends a price; an invalid/unavailable token is rejected as 'unknown'.
 * unit_price is in grosze (PLN) or euro-cents (EUR) depending on currency.
 */
export function validateCart(rawIds: unknown, currency: 'pln' | 'eur' = 'pln'): ValidateResult {
  if (!Array.isArray(rawIds) || rawIds.length === 0) return { ok: false, reason: 'empty' };
  if (rawIds.length > MAX_CART) return { ok: false, reason: 'too_many' };

  const seen = new Set<string>();
  const items: CheckoutItem[] = [];
  for (const raw of rawIds) {
    if (typeof raw !== 'string' || seen.has(raw)) continue;

    if (isPrintToken(raw)) {
      const dec = decodePrintToken(raw);
      if (!dec) return { ok: false, reason: 'unknown' };
      const design = getPrintById(dec.designId);
      if (!design || !isVariantAvailable(design, dec.sel)) return { ok: false, reason: 'unknown' };
      seen.add(raw);
      const major = priceOfVariant(dec.sel, currency);
      const unit_price = currency === 'eur' ? toEuroCents(major) : toGrosze(major);
      items.push({ product_id: dec.designId, unit_price, variant: { ...dec.sel, sku: skuOf(design, dec.sel) } });
      continue;
    }

    const product = getProductById(raw);
    if (!product) return { ok: false, reason: 'unknown' };
    seen.add(raw);
    const unit_price = currency === 'eur'
      ? toEuroCents(PRICE_EUR[product.category])
      : toGrosze(product.price);
    items.push({ product_id: raw, unit_price });
  }
  if (items.length === 0) return { ok: false, reason: 'empty' };
  return { ok: true, items };
}
