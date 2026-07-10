import { getProductById, isCategoryHidden, registryProducts } from './products';
import { PRICE_EUR, PRICE_GBP, toEuroCents, toGrosze, toGBPPence } from './pricing';
import { getPrintById, isVariantAvailable, registryPrintDesigns } from './prints';
import { decodePrintToken, isPrintToken, variantKey, PRODIGI_SKU_MAP } from './print-cart';
import { priceOfVariant } from './print-pricing';
import type { PrintVariantSelection } from './types';

// Hard sanity bound: every one-of-a-kind ceramic plus every print design in
// each of its 21 fulfilment variants. Derived so it can't drift when the
// catalogue changes. Uses the code registry (not the async DB accessors) so it
// stays a module-load constant — it is an upper bound, and registry == DB at
// parity, so the exact source is immaterial here.
export const MAX_CART = registryProducts().length + registryPrintDesigns().length * 21;

export type CheckoutVariant = PrintVariantSelection & {
  prodigiSku: string;
  printAreaPx: { w: number; h: number };
};

export type CheckoutItem = { product_id: string; unit_price: number; variant?: CheckoutVariant };
export type ValidateResult =
  | { ok: true; items: CheckoutItem[] }
  | { ok: false; reason: 'empty' | 'too_many' | 'unknown' | 'not_for_sale' | 'mixed_cart' };

/**
 * Resolve raw cart ids to deduped, catalog-known items.
 * unit_price is in grosze (PLN), euro-cents (EUR), or pence (GBP) depending on currency.
 */
export async function validateCart(rawIds: unknown, currency: 'pln' | 'eur' | 'gbp' = 'pln'): Promise<ValidateResult> {
  if (!Array.isArray(rawIds) || rawIds.length === 0) return { ok: false, reason: 'empty' };
  if (rawIds.length > MAX_CART) return { ok: false, reason: 'too_many' };

  const seen = new Set<string>();
  const items: CheckoutItem[] = [];
  for (const raw of rawIds) {
    if (typeof raw !== 'string' || seen.has(raw)) continue;
    if (isPrintToken(raw)) {
      const dec = decodePrintToken(raw);
      if (!dec) return { ok: false, reason: 'unknown' };
      const design = await getPrintById(dec.designId);
      if (!design || !isVariantAvailable(design, dec.sel)) return { ok: false, reason: 'unknown' };
      const skuInfo = PRODIGI_SKU_MAP[variantKey(dec.sel)];
      if (!skuInfo) return { ok: false, reason: 'unknown' };
      seen.add(raw);
      const major = priceOfVariant(design, dec.sel, currency);
      const unit_price =
        currency === 'eur' ? toEuroCents(major) :
        currency === 'gbp' ? toGBPPence(major) :
        toGrosze(major);
      items.push({
        product_id: dec.designId,
        unit_price,
        variant: { ...dec.sel, prodigiSku: skuInfo.sku, printAreaPx: skuInfo.printAreaPx },
      });
      continue;
    }
    const id = raw;
    const product = await getProductById(id);
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
  // Hard rule: ceramics (drops + InPost) and prints (Prodigi) are separate
  // orders — a cart can never mix the two.
  if (items.some((i) => i.variant) && items.some((i) => !i.variant)) {
    return { ok: false, reason: 'mixed_cart' };
  }
  return { ok: true, items };
}
