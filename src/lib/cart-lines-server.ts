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
     - print:    getPrintById() (resolves unpublished too, same as
                 validateCart — isVariantAvailable() itself gates on
                 `published`) + withRegistryMockups() to preserve the
                 registry-only mockups/editorialGallery fields a DB-sourced
                 design never carries (see print-mockups.ts). Cached per
                 design id within one call — a cart can hold several
                 variants of the same print.
     - giftcard: fully static/sync, no DB — same as before.

   An id that doesn't resolve (unknown, withdrawn, malformed token, sold-out
   variant) returns an explicit `{ kind: 'unavailable', id }` line instead of
   being silently dropped, so the cart can tell "no longer available" apart
   from "never existed" — the old resolver could not make that distinction.
   ============================================================ */
import { resolveKnownProducts, isCategoryHidden, isProductPublic } from './products';
import { withCeramicSaleState } from './ceramic-sale-state';
import { getPrintById, isVariantAvailable, registryPrintById } from './prints';
import { withRegistryMockups } from './print-mockups';
import { decodePrintToken, isPrintToken } from './print-cart';
import { decodeGiftCardToken, getGiftCardTier, isGiftCardToken } from './gift-cards';
import type { GiftCardTier } from './gift-cards';
import { loadPrintCollectionDefinitions } from './print-collections';
import { printDisplayName } from './print-curation';
import type { PrintCollectionDefinition } from './print-curation';
import type { PrintDesign, PrintVariantSelection, Product } from './types';

export type CartLine =
  | { kind: 'ceramic'; id: string; product: Product }
  | { kind: 'print'; id: string; design: PrintDesign; sel: PrintVariantSelection; name: string }
  | { kind: 'giftcard'; id: string; tier: GiftCardTier }
  | { kind: 'unavailable'; id: string };

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
 * Resolve cart ids to deduped, renderable lines (ceramics + prints + gift
 * cards), server-side and DB-aware. Preserves first-seen order like the
 * resolver it replaces.
 */
export async function resolveCartLinesServer(rawIds: string[]): Promise<CartLine[]> {
  // Loaded lazily below, only the first time a valid+available print line
  // actually needs its display name — a cart with no print items (or only
  // unavailable/unknown ones) never pays for the two Supabase reads +
  // fallback machinery inside loadPrintCollectionDefinitions().
  let definitions: PrintCollectionDefinition[] | undefined;
  const seen = new Set<string>();
  const orderedIds: string[] = [];
  for (const id of rawIds) {
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue;
    seen.add(id);
    orderedIds.push(id);
  }

  const ceramicIds = orderedIds.filter((id) => !isGiftCardToken(id) && !isPrintToken(id));
  const ceramicProducts = await resolveCeramicProductsById(ceramicIds);

  // Cache per design id — a print cart can hold several size/colour variants
  // of the same design, and each only needs one DB read + registry merge.
  const printDesigns = new Map<string, PrintDesign | undefined>();
  async function resolvePrintDesign(designId: string): Promise<PrintDesign | undefined> {
    if (printDesigns.has(designId)) return printDesigns.get(designId);
    const design = await getPrintById(designId);
    const merged = design ? withRegistryMockups(design, registryPrintById(designId)) : undefined;
    printDesigns.set(designId, merged);
    return merged;
  }

  const lines: CartLine[] = [];
  for (const id of orderedIds) {
    if (isGiftCardToken(id)) {
      const dec = decodeGiftCardToken(id);
      const tier = dec ? getGiftCardTier(dec.tierId) : null;
      lines.push(tier ? { kind: 'giftcard', id, tier } : { kind: 'unavailable', id });
      continue;
    }
    if (isPrintToken(id)) {
      const dec = decodePrintToken(id);
      if (!dec) {
        lines.push({ kind: 'unavailable', id });
        continue;
      }
      const design = await resolvePrintDesign(dec.designId);
      if (!design || !isVariantAvailable(design, dec.sel)) {
        lines.push({ kind: 'unavailable', id });
        continue;
      }
      if (!definitions) definitions = await loadPrintCollectionDefinitions();
      lines.push({ kind: 'print', id, design, sel: dec.sel, name: printDisplayName(design, 'Print', definitions) });
      continue;
    }
    const product = ceramicProducts.get(id);
    lines.push(product ? { kind: 'ceramic', id, product } : { kind: 'unavailable', id });
  }
  return lines;
}
