import type { Product } from '@/lib/types';

/** The three shop views: everything, only purchasable, only sold. */
export type StatusFilter = 'all' | 'available' | 'sold';

/** Render order of the segmented control. */
export const STATUS_FILTERS: StatusFilter[] = ['all', 'available', 'sold'];

/**
 * Narrow a product list to the active status view. Pure (no store / no React),
 * so it is unit-testable and shared by the hub (GroupedGallery) and collection
 * (Gallery) surfaces. Order is preserved — `available` is the same subset/order
 * the lightbox already steps across, so filtering never reorders tiles.
 */
export function filterByStatus(products: Product[], status: StatusFilter): Product[] {
  switch (status) {
    case 'available':
      // Showroom pieces are visible but not purchasable — excluded from "available".
      return products.filter((p) => !p.sold && !p.showroom);
    case 'sold':
      return products.filter((p) => p.sold);
    default:
      return products;
  }
}
