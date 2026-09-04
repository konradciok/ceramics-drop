import { getProductById, isProductPublic, registryProducts } from './products';
import { PRICE_EUR, PRICE_GBP, toMinor } from './pricing';
import { getPrintById, isVariantAvailable, registryPrintDesigns } from './prints';
import { assetPxFor, decodePrintToken, isPrintToken, variantKey, PRODIGI_SKU_MAP } from './print-cart';
import { priceOfVariant, type PrintPricingConfig } from './print-pricing';
import { getPrintPricingConfig } from './print-pricing-config/get';
import { resolvePrintAsset } from '@/server/print-assets/repository';
import { GIFT_CARD_TIERS, isGiftCardToken, resolveGiftCardToken, type GiftCardTierId } from './gift-cards';
import type { PrintVariantSelection } from './types';

// Hard sanity bound: every one-of-a-kind ceramic plus every print design in
// each of its 21 fulfilment variants, plus every gift-card tier. Derived so it
// can't drift when the catalogue changes. Uses the code registry (not the
// async DB accessors) so it stays a module-load constant — it is an upper
// bound, and registry == DB at parity, so the exact source is immaterial here.
export const MAX_CART =
  registryProducts().length + registryPrintDesigns().length * 21 + GIFT_CARD_TIERS.length;

export type CheckoutVariant = PrintVariantSelection & {
  prodigiSku: string;
  /**
   * Snapshot of the ASSET-dimension contract (assetPxFor), not necessarily
   * Prodigi's reported print area — for `30x40:true:false:black` this is the
   * shared 3600×4800 render submitted with sizing "fillPrintArea"
   * (prodigi/decisions.md #6). Field name kept for snapshot compatibility.
   */
  printAreaPx: { w: number; h: number };
  assetId: string;
  assetKey: string;
  assetSha256: string;
  assetContentType: 'image/jpeg' | 'image/png';
  assetWidthPx: number;
  assetHeightPx: number;
};

export type CheckoutItem = {
  product_id: string;
  unit_price: number;
  variant?: CheckoutVariant;
  /** Set for a gift-card line — mutually exclusive with `variant`. See gift-cards.ts. */
  giftCardTierId?: GiftCardTierId;
};
export type ValidateResult =
  | { ok: true; items: CheckoutItem[] }
  | {
      ok: false;
      reason:
        | 'empty'
        | 'too_many'
        | 'unknown'
        | 'not_for_sale'
        | 'mixed_cart'
        | 'multiple_gift_cards'
        | 'print_asset_unavailable'
        | 'print_asset_error';
    };

/**
 * Resolve raw cart ids to deduped, catalog-known items.
 * unit_price is in grosze (PLN), euro-cents (EUR), or pence (GBP) depending on currency.
 */
export async function validateCart(rawIds: unknown, currency: 'pln' | 'eur' | 'gbp' = 'pln'): Promise<ValidateResult> {
  if (!Array.isArray(rawIds) || rawIds.length === 0) return { ok: false, reason: 'empty' };
  if (rawIds.length > MAX_CART) return { ok: false, reason: 'too_many' };

  const seen = new Set<string>();
  const items: CheckoutItem[] = [];
  // Loaded lazily on the first print token so ceramic-only carts skip it.
  // This is THE price of record for prints — the client never sends a price.
  let pricing: PrintPricingConfig | null = null;
  for (const raw of rawIds) {
    if (typeof raw !== 'string' || seen.has(raw)) continue;
    if (isGiftCardToken(raw)) {
      const line = resolveGiftCardToken(raw, currency);
      if (!line) return { ok: false, reason: 'unknown' };
      seen.add(raw);
      items.push({ product_id: line.tierId, unit_price: line.unitPriceMinor, giftCardTierId: line.tierId });
      continue;
    }
    if (isPrintToken(raw)) {
      const dec = decodePrintToken(raw);
      if (!dec) return { ok: false, reason: 'unknown' };
      const design = await getPrintById(dec.designId);
      if (!design || !isVariantAvailable(design, dec.sel)) return { ok: false, reason: 'unknown' };
      const skuInfo = PRODIGI_SKU_MAP[variantKey(dec.sel)];
      if (!skuInfo) return { ok: false, reason: 'unknown' };
      let asset;
      try {
        asset = await resolvePrintAsset(dec.designId, variantKey(dec.sel));
      } catch {
        // Transient Supabase error — let the buyer retry rather than collapsing
        // checkout with a 500 before any PI or reservation is created.
        return { ok: false, reason: 'print_asset_error' };
      }
      if (!asset) return { ok: false, reason: 'print_asset_unavailable' };
      seen.add(raw);
      pricing ??= await getPrintPricingConfig();
      const major = priceOfVariant(dec.sel, currency, pricing);
      const unit_price = toMinor(major);
      items.push({
        product_id: dec.designId,
        unit_price,
        variant: {
          ...dec.sel,
          prodigiSku: skuInfo.sku,
          printAreaPx: assetPxFor(skuInfo),
          assetId: asset.assetId,
          assetKey: asset.r2Key,
          assetSha256: asset.sha256,
          assetContentType: asset.contentType,
          assetWidthPx: asset.widthPx,
          assetHeightPx: asset.heightPx,
        },
      });
      continue;
    }
    const id = raw;
    const product = await getProductById(id);
    if (!product) return { ok: false, reason: 'unknown' };
    // Hard block: a withdrawn product (hidden family, or a non-active DB status
    // draft/hidden/archived) can never be bought — not via a stale cart, not via
    // a private-sale link (validateCart runs before either reservation).
    if (!isProductPublic(product)) return { ok: false, reason: 'not_for_sale' };
    seen.add(id);
    const major =
      currency === 'eur' ? PRICE_EUR[product.category] :
      currency === 'gbp' ? PRICE_GBP[product.category] :
      product.price;
    const unit_price = toMinor(major);
    items.push({ product_id: id, unit_price });
  }
  if (items.length === 0) return { ok: false, reason: 'empty' };
  const hasGiftCards = items.some((i) => i.giftCardTierId != null);
  // Hard rule: gift cards are their own exclusive track — no shipping, no
  // piece reservation, and (like ceramics vs. prints below) never mixed with
  // anything else in the same order.
  if (hasGiftCards && items.some((i) => i.giftCardTierId == null)) {
    return { ok: false, reason: 'mixed_cart' };
  }
  // A gift-card checkout maps 1:1 to a single minted promo_codes row
  // (Option A) — supporting several gift-card lines in one order would need
  // multiple mints per order, which the schema deliberately doesn't support.
  // Buy additional gift cards via separate checkouts.
  if (hasGiftCards && new Set(items.map((i) => i.giftCardTierId)).size > 1) {
    return { ok: false, reason: 'multiple_gift_cards' };
  }
  // Hard rule: ceramics (drops + InPost) and prints (Prodigi) are separate
  // orders — a cart can never mix the two.
  if (!hasGiftCards && items.some((i) => i.variant) && items.some((i) => !i.variant)) {
    return { ok: false, reason: 'mixed_cart' };
  }
  return { ok: true, items };
}
