import type { Product } from '@/lib/types';
import { isProductPurchasable } from '@/lib/products';

/** Tiles in the PDP "more from this collection" strip. */
export const PDP_SIBLINGS_MAX = 4;
/** On a sold PDP the strip only shows pieces that can still be bought. */
export const SOLD_PDP_SIBLINGS_MAX = 3;

/**
 * Picks the "more from this collection" tiles for a PDP. `siblings` are the
 * category's listed pieces with the live sold / showroom overlay already
 * applied; the current piece is dropped if present. Pure, so it is unit-tested.
 *
 * - On a sold PDP the visitor has hit a dead end, so only purchasable pieces
 *   are recommended (up to three). An empty result means the category has
 *   nothing left to buy — the caller shows the newsletter signup instead.
 * - Everywhere else purchasable pieces come first and badged ones (sold or
 *   showroom) only fill the strip up to four, each group keeping its
 *   catalogue order. Unsold, unbadged pieces that cannot be bought right now
 *   (under a live checkout hold, or offline) are never recommended: their tile
 *   would look buyable and their PDP would not be.
 *
 * Applies to every PDP that renders, including the ended drop's archive
 * pieces: `siblings` come from the live listing, so a sold archive piece
 * points at its family's pieces on sale now.
 */
export function pickPdpSiblings(product: Product, siblings: readonly Product[]): Product[] {
  const others = siblings.filter((p) => p.id !== product.id);
  if (product.sold) return others.filter(isProductPurchasable).slice(0, SOLD_PDP_SIBLINGS_MAX);
  return [
    ...others.filter(isProductPurchasable),
    ...others.filter((p) => !isProductPurchasable(p) && (p.sold || p.showroom)),
  ].slice(0, PDP_SIBLINGS_MAX);
}
