import { describe, expect, it } from 'vitest';
import { buildNewPrintBatch } from './new-print-batch';
import { assetPxFor, PRODIGI_SKU_MAP } from '../../src/lib/print-cart';
import { registryPrintDesigns } from '../../src/lib/prints';

describe('September print batch staging', () => {
  it('stages exactly 16 drafts without exposing unfinished media or public products', () => {
    const seed = buildNewPrintBatch();
    expect(seed.products.map((p) => p.id)).toEqual(Array.from({ length: 16 }, (_, i) => `fap${String(i + 42).padStart(3, '0')}`));
    expect(seed.products.every((p) => p.status === 'draft')).toBe(true);
    expect(seed.media).toEqual([]);
    expect(registryPrintDesigns().some((p) => seed.products.some((row) => row.id === p.id))).toBe(false);
    expect(seed.products.find((p) => p.id === 'fap044')?.seo_title).toBe('Aurora 04');
    expect(seed.products.find((p) => p.id === 'fap049')?.seo_title).toBe('Cumulus 06');
  });
  it('prepares 12 active variants per draft with canonical fulfilment dimensions', () => {
    const seed = buildNewPrintBatch();
    expect(seed.variants).toHaveLength(192);
    for (const product of seed.products) {
      const variants = seed.variants.filter((v) => v.product_id === product.id);
      expect(variants).toHaveLength(12);
      expect(new Set(variants.map((v) => v.variant_key)).size).toBe(12);
      expect(variants.filter((v) => v.is_default)).toHaveLength(1);
      for (const v of variants) {
        expect(v.active).toBe(true);
        expect(v.axes?.mount).toBe(false);
        expect({ w: v.print_area_width_px, h: v.print_area_height_px }).toEqual(assetPxFor(PRODIGI_SKU_MAP[v.variant_key]));
      }
    }
  });
});
