/* ============================================================
   Unified cart lines — server-side, DB-aware resolver (S2b).
   ------------------------------------------------------------
   Replaces the old client-side cart-lines.ts, which read the sync code
   registry only (it physically could not reach the service-role Supabase
   client from the browser) and needed a manually prop-drilled
   `knownProducts` fallback map for any DB-only (CMS-created) product — a
   stopgap threaded through 5 files. This runs server-side (GET
   /api/cart-lines), so it reaches the same CATALOG_SOURCE-aware accessors
   checkout's validateCart() already uses per kind, instead of duplicating
   that dispatch logic:

     - ceramic:  resolveKnownProducts() (batched — one catalog load for every
                 ceramic id in the cart) + withCeramicSaleState() (sold/
                 showroom overlay), same as getProductById() applies per-id.
     - print:    retired (prints moved to their own shop, 2026-11) — a
                 stale `print:` token resolves to an `unavailable` line.
     - giftcard: fully static/sync, no DB — same as before.

   An id that doesn't resolve (unknown, withdrawn, malformed token, sold-out
   variant) returns an explicit `{ kind: 'unavailable', id }` line instead of
   being silently dropped, so the cart can tell "no longer available" apart
   from "never existed" — the old resolver could not make that distinction.
   ============================================================ */
import { resolveKnownProducts, isCategoryHidden, isProductPublic } from './products';
import { withCeramicSaleState } from './ceramic-sale-state';
import { decodeGiftCardToken, getGiftCardTier, isGiftCardToken } from './gift-cards';
import type { GiftCardTier } from './gift-cards';
import { isRetiredPrintToken } from './legacy-print-lines';
import type { Product } from './types';
import type { Locale } from '@/i18n/routing';

export type CartLine =
  | { kind: 'ceramic'; id: string; product: Product }
  | { kind: 'giftcard'; id: string; tier: GiftCardTier }
  | { kind: 'unavailable'; id: string };

type CartLineLocale = Locale;

/** Batch-resolve every ceramic id in one catalog load + one sale-state fetch,
 *  applying the same public-visibility gate isProductPublic() enforces
 *  elsewhere (a withdrawn/hidden-family product is "unavailable" here, not
 *  silently returned as if nothing changed). Sold/showroom pieces ARE kept —
 *  that's a separate, already-handled concern (the /api/inventory-driven
 *  prune-with-notice in CartView), not this resolver's job. */
async function resolveCeramicProductsById(ids: string[]): Promise<Map<string, Product>> {
  if (ids.length === 0) return new Map();
  const products = await resolveKnownProducts(ids);
  const withState = await withCeramicSaleState(products);
  const byId = new Map(withState.map((p) => [p.id, p]));
  for (const [id, product] of byId) {
    if (isCategoryHidden(product.category) || !isProductPublic(product)) byId.delete(id);
  }
  return byId;
}

/**
 * Resolve cart ids to deduped, renderable lines (ceramics + gift cards),
 * server-side and DB-aware. Preserves first-seen order like the resolver it
 * replaces. `locale` is kept for callers; no line kind is localised here now.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function resolveCartLinesServer(rawIds: string[], _locale: CartLineLocale = 'pl'): Promise<CartLine[]> {
  const seen = new Set<string>();
  const orderedIds: string[] = [];
  for (const id of rawIds) {
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
    seen.add(id);
    orderedIds.push(id);
  }

  const ceramicIds = orderedIds.filter((id) => !isGiftCardToken(id) && !isRetiredPrintToken(id));
  const ceramicProducts = await resolveCeramicProductsById(ceramicIds);

  const lines: CartLine[] = [];
  for (const id of orderedIds) {
    if (isGiftCardToken(id)) {
      const dec = decodeGiftCardToken(id);
      const tier = dec ? getGiftCardTier(dec.tierId) : null;
      lines.push(tier ? { kind: 'giftcard', id, tier } : { kind: 'unavailable', id });
      continue;
    }
    // Prints are no longer sold here; a stale token is just "no longer available".
    if (isRetiredPrintToken(id)) {
      lines.push({ kind: 'unavailable', id });
      continue;
    }
    const product = ceramicProducts.get(id);
    lines.push(product ? { kind: 'ceramic', id, product } : { kind: 'unavailable', id });
  }
  return lines;
}
