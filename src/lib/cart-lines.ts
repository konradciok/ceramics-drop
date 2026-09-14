/* ============================================================
   Unified cart lines — resolve the flat id list to renderable lines.
   ------------------------------------------------------------
   The cart store is a flat string[] mixing ceramic ids (`k01`) and print
   tokens (`print:fap01:a3:satin:oak`). This resolves both to a tagged union
   the cart UI can render. Unknown / unavailable entries are dropped.

   This runs client-side, so it reads the code registry synchronously via the
   `registry*` helpers — it physically cannot call the service-role Supabase
   client. checkout's `validateCart` reads the CATALOG_SOURCE-aware async
   accessors instead. Production runs CATALOG_SOURCE='db', but this client-side
   resolver still reads the code registry (it cannot reach the service-role DB
   client from the browser); the two are kept at parity so the client view
   matches, plus an optional `knownProducts` fallback map — ids the calling
   server component already fetched DB-aware (e.g. getPublicProducts) — so a
   CMS-created (DB-only) ceramic still resolves for display here even though
   it's absent from the code registry. A full server-side cart-resolve DTO is
   a future follow-up (S2b).
   ============================================================ */
import { registryProductById, isCategoryHidden } from './products';
import { registryPrintById, isVariantAvailable } from './prints';
import { decodePrintToken, isPrintToken } from './print-cart';
import { decodeGiftCardToken, getGiftCardTier, isGiftCardToken } from './gift-cards';
import type { GiftCardTier } from './gift-cards';
import type { PrintDesign, PrintVariantSelection, Product } from './types';

export type CartLine =
  | { kind: 'ceramic'; id: string; product: Product }
  | { kind: 'print'; id: string; design: PrintDesign; sel: PrintVariantSelection }
  | { kind: 'giftcard'; id: string; tier: GiftCardTier };

/**
 * Resolve cart ids to deduped, renderable lines (ceramics + available prints
 * + gift cards). `knownProducts` (id → Product) is an optional fallback for
 * ceramic ids absent from the code registry — a DB-only product a server
 * component already resolved DB-aware.
 */
export function resolveCartLines(ids: string[], knownProducts?: Record<string, Product>): CartLine[] {
  const seen = new Set<string>();
  const lines: CartLine[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    if (isGiftCardToken(id)) {
      const dec = decodeGiftCardToken(id);
      if (!dec) continue;
      const tier = getGiftCardTier(dec.tierId);
      if (!tier) continue;
      seen.add(id);
      lines.push({ kind: 'giftcard', id, tier });
    } else if (isPrintToken(id)) {
      const dec = decodePrintToken(id);
      if (!dec) continue;
      const design = registryPrintById(dec.designId);
      if (!design || !isVariantAvailable(design, dec.sel)) continue;
      seen.add(id);
      lines.push({ kind: 'print', id, design, sel: dec.sel });
    } else {
      const product = registryProductById(id) ?? knownProducts?.[id];
      if (!product) continue;
      if (isCategoryHidden(product.category)) continue;
      seen.add(id);
      lines.push({ kind: 'ceramic', id, product });
    }
  }
  return lines;
}
