import mapping from '../../config/print-assets/batches/2026-09-new-prints/nowe-printy-2026-mapowanie.json';
import { buildCatalogSeed } from '../../src/lib/catalog/seed';
import type { CatalogSeed } from '../../src/lib/catalog/types';

/** Stage this batch separately from the public fallback registry until its media exists. */
export function buildNewPrintBatch(): CatalogSeed {
  const existing = buildCatalogSeed();
  // fap041 has the approved three sizes, three frame colours and no mount.
  // Reuse the canonical seed projection for pricing, SKUs and asset dimensions.
  const template = existing.products.find((p) => p.id === 'fap041');
  const variants = existing.variants.filter((v) => v.product_id === 'fap041');
  if (!template || variants.length !== 12 || variants.some((v) => v.axes?.mount
    || !v.sku || !v.print_area_width_px || !v.print_area_height_px)) {
    throw new Error('Batch template no longer matches the approved non-mount variants');
  }
  const seed: CatalogSeed = { products: [], variants: [], media: [] };
  const ids = new Set<string>();
  mapping.prints.forEach((print, index) => {
    if (ids.has(print.productId)) throw new Error(`Already in registry: ${print.productId}`);
    ids.add(print.productId);
    seed.products.push({
      ...template,
      id: print.productId,
      num: String(40 + index).padStart(2, '0'),
      status: 'draft',
      note_index: Number(print.productId.slice(3)) - 1,
      seo_title: print.displayName,
      seo_description: null,
      title: null,
      description: null,
    });
    seed.variants.push(...variants.map((v) => ({ ...v, product_id: print.productId, active: true })));
  });
  // No placeholder media rows: hero/editorial assets are produced in a later step.
  return seed;
}
