import type { Product } from '@/lib/types';
import { isProductPurchasable } from '@/lib/products';

/** The three shop views: everything, only purchasable, only sold. */
export type StatusFilter = 'all' | 'available' | 'sold';

/** Render order of the segmented control. */
export const STATUS_FILTERS: StatusFilter[] = ['all', 'available', 'sold'];

/**
 * Narrow a product list to the active status view. Pure (no store / no React),
 * so it is unit-testable and shared by the per-category collection (Gallery)
 * surfaces. Order is preserved — `available` is the same subset/order the
 * lightbox already steps across, so filtering never reorders tiles.
 */
export function filterByStatus(products: Product[], status: StatusFilter): Product[] {
  switch (status) {
    case 'available':
      // Showroom pieces are visible but not purchasable — excluded from "available".
      return products.filter((p) => p.onlineAvailable === true && !p.sold && !p.showroom);
    case 'sold':
      return products.filter((p) => p.sold);
    default:
      return products;
  }
}

/**
 * Stable partition for shop grids: purchasable pieces first, then everything
 * else (sold / showroom), each group keeping its original order. Sold pieces
 * stay visible as sold — they just sink to the end of their family.
 */
export function purchasableFirst(products: Product[]): Product[] {
  return [
    ...products.filter(isProductPurchasable),
    ...products.filter((p) => !isProductPurchasable(p)),
  ];
}

/** The state label a shop tile wears, if any. */
export type TileSaleBadge = 'sold' | 'showroom' | 'reserved';

/**
 * Which label a tile shows: showroom wins over sold (a retired piece may also
 * be sold); a piece held by an open checkout says so instead of showing a dead
 * add button with no explanation; a purchasable piece has none.
 */
export function tileSaleBadge(product: Product): TileSaleBadge | null {
  if (product.showroom) return 'showroom';
  if (product.sold) return 'sold';
  if (product.saleState === 'reserved') return 'reserved';
  return null;
}

/**
 * Message key for the disabled buy button of a piece that cannot be bought
 * right now. A piece held by an open checkout says "reserved" — the same word
 * its shop tile wears — instead of the generic "not available online".
 */
export function unavailableLabelKey(product: Product): 'gallery.sold' | 'ceramics.reserved' | 'ceramics.unavailable' {
  if (product.sold) return 'gallery.sold';
  return tileSaleBadge(product) === 'reserved' ? 'ceramics.reserved' : 'ceramics.unavailable';
}
