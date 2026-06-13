/* ============================================================
   Unified cart lines — resolve the flat id list to renderable lines.
   ------------------------------------------------------------
   The cart store is a flat string[] mixing ceramic ids (`k01`) and print
   tokens (`print:fap01:a3:satin:oak`). This resolves both to a tagged union
   the cart UI can render, mirroring validateCart's server-side resolution so
   the two never diverge. Unknown / unavailable entries are dropped.
   ============================================================ */
import { getProductById } from './products';
import { getPrintById, isVariantAvailable } from './prints';
import { decodePrintToken, isPrintToken } from './print-cart';
import type { PrintDesign, PrintVariantSelection, Product } from './types';

export type CartLine =
  | { kind: 'ceramic'; id: string; product: Product }
  | { kind: 'print'; id: string; design: PrintDesign; sel: PrintVariantSelection };

/** Resolve cart ids to deduped, renderable lines (ceramics + available prints). */
export function resolveCartLines(ids: string[]): CartLine[] {
  const seen = new Set<string>();
  const lines: CartLine[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    if (isPrintToken(id)) {
      const dec = decodePrintToken(id);
      if (!dec) continue;
      const design = getPrintById(dec.designId);
      if (!design || !isVariantAvailable(design, dec.sel)) continue;
      seen.add(id);
      lines.push({ kind: 'print', id, design, sel: dec.sel });
    } else {
      const product = getProductById(id);
      if (!product) continue;
      seen.add(id);
      lines.push({ kind: 'ceramic', id, product });
    }
  }
  return lines;
}
