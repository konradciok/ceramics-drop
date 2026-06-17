import { getProductById, getProducts, isCategoryHidden } from './products';
import { PRICE_EUR, PRICE_GBP, toEuroCents, toGrosze, toGBPPence } from './pricing';

// Hard sanity bound: a cart can never hold more than the whole (one-of-a-kind)
// catalogue. Derived so it can't drift when the catalogue changes.
export const MAX_CART = getProducts().length;

export type CheckoutItem = { product_id: string; unit_price: number };
export type ValidateResult =
  | { ok: true; items: CheckoutItem[] }
  | { ok: false; reason: 'empty' | 'too_many' | 'unknown' | 'not_for_sale' };

/**
 * Resolve raw cart ids to deduped, catalog-known items.
 * unit_price is in grosze (PLN), euro-cents (EUR), or pence (GBP) depending on currency.
 */
export function validateCart(rawIds: unknown, currency: 'pln' | 'eur' | 'gbp' = 'pln'): ValidateResult {
  if (!Array.isArray(rawIds) || rawIds.length === 0) return { ok: false, reason: 'empty' };
  if (rawIds.length > MAX_CART) return { ok: false, reason: 'too_many' };

  const seen = new Set<string>();
  const items: CheckoutItem[] = [];
  for (const id of rawIds) {
    if (typeof id !== 'string' || seen.has(id)) continue;
    const product = getProductById(id);
    if (!product) return { ok: false, reason: 'unknown' };
    // Hard block: a withdrawn family can never be bought — not via a stale cart,
    // not via a private-sale link (validateCart runs before either reservation).
    if (isCategoryHidden(product.category)) return { ok: false, reason: 'not_for_sale' };
    seen.add(id);
    const unit_price =
      currency === 'eur' ? toEuroCents(PRICE_EUR[product.category]) :
      currency === 'gbp' ? toGBPPence(PRICE_GBP[product.category]) :
      toGrosze(product.price);
    items.push({ product_id: id, unit_price });
  }
  if (items.length === 0) return { ok: false, reason: 'empty' };
  return { ok: true, items };
}
