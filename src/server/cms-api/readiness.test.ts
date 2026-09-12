import { describe, expect, it } from 'vitest';
import { buildPrintVariantSpecs, computeReadiness } from './readiness';
import type { PrintDraft, ProductResponse } from './types';

function makeQuery(data: unknown[]) {
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.eq = () => builder;
  builder.then = (resolve: (v: { data: unknown[]; error: null }) => void) => resolve({ data, error: null });
  return builder;
}

function fakeSupabase(tables: Record<string, unknown[]>) {
  return { from: (table: string) => makeQuery(tables[table] ?? []) } as never;
}

const printDraft: PrintDraft = {
  type: 'print',
  displayNumber: '01',
  sizes: ['30x40'],
  frameColours: ['black'],
  mountAvailable: false,
  images: ['a.webp'],
  title: { pl: 'Test' },
  description: { pl: 'Opis' },
};

describe('buildPrintVariantSpecs', () => {
  it('expands unframed + each frame colour, honoring mountAvailable', () => {
    const specs = buildPrintVariantSpecs(printDraft);
    expect(specs.map((s) => s.variant_key)).toEqual(['30x40:false:false:none', '30x40:true:false:black']);
  });

  it('adds a mounted variant per frame colour when mountAvailable is true', () => {
    const specs = buildPrintVariantSpecs({ ...printDraft, mountAvailable: true });
    expect(specs.map((s) => s.variant_key)).toEqual([
      '30x40:false:false:none',
      '30x40:true:false:black',
      '30x40:true:true:black',
    ]);
  });

  it('excludes variantKeys listed in unavailable', () => {
    const specs = buildPrintVariantSpecs({ ...printDraft, unavailable: ['30x40:false:false:none'] });
    expect(specs.map((s) => s.variant_key)).toEqual(['30x40:true:false:black']);
  });

  it('looks up real print-area pixels from PRODIGI_SKU_MAP', () => {
    const specs = buildPrintVariantSpecs(printDraft);
    expect(specs[0]).toMatchObject({ sku: 'GLOBAL-FAP-12X16', print_area_width_px: 3600, print_area_height_px: 4800 });
  });
});

describe('computeReadiness', () => {
  const ceramicProduct: ProductResponse = {
    id: 'k01',
    type: 'ceramic',
    revision: 1,
    publishedRevision: null,
    status: 'draft',
    draft: { type: 'ceramic', category: 'kubki', displayNumber: '01', measure: '', pricePln: 100, priceEur: 20, priceGbp: 18, images: ['a.webp'], title: { pl: 'Kubek' }, description: { pl: 'Opis' }, showroom: false },
    thumbnail: 'a.webp',
    proofs: [],
    availability: 'available',
  };

  it('ceramics are always ready (already fully validated at save time)', async () => {
    const supabase = fakeSupabase({});
    const result = await computeReadiness(supabase, ceramicProduct);
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it('warns when no non-PL locale is present', async () => {
    const supabase = fakeSupabase({});
    const result = await computeReadiness(supabase, ceramicProduct);
    expect(result.warnings).toContain('Brak EN, ES lub DE: sklep użyje treści PL.');
  });

  it('does not warn when an EN title is present', async () => {
    const supabase = fakeSupabase({});
    const withEn = { ...ceramicProduct, draft: { ...ceramicProduct.draft, title: { pl: 'Kubek', en: 'Mug' } } };
    const result = await computeReadiness(supabase, withEn);
    expect(result.warnings).toEqual([]);
  });

  const printProduct: ProductResponse = {
    id: 'fap001',
    type: 'print',
    revision: 1,
    publishedRevision: null,
    status: 'draft',
    draft: printDraft,
    thumbnail: 'a.webp',
    proofs: [],
    availability: 'available',
  };

  it('blocks a print with no assigned/ready asset for a required variant', async () => {
    const supabase = fakeSupabase({ print_variant_asset_assignments: [], print_fulfilment_assets: [] });
    const result = await computeReadiness(supabase, printProduct);
    expect(result.ready).toBe(false);
    expect(result.blockers.length).toBeGreaterThan(0);
  });

  it('is ready when every variant has a dimension-matched ready asset', async () => {
    const supabase = fakeSupabase({
      print_variant_asset_assignments: [
        { variant_key: '30x40:false:false:none', asset_id: 'a1' },
        { variant_key: '30x40:true:false:black', asset_id: 'a2' },
      ],
      print_fulfilment_assets: [
        { id: 'a1', status: 'ready', width_px: 3600, height_px: 4800 },
        { id: 'a2', status: 'ready', width_px: 3614, height_px: 4795 },
      ],
    });
    const result = await computeReadiness(supabase, printProduct);
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it('blocks when the assigned asset is staged rather than ready', async () => {
    const supabase = fakeSupabase({
      print_variant_asset_assignments: [{ variant_key: '30x40:false:false:none', asset_id: 'a1' }],
      print_fulfilment_assets: [{ id: 'a1', status: 'staged', width_px: 3600, height_px: 4800 }],
    });
    const result = await computeReadiness(supabase, printProduct);
    expect(result.ready).toBe(false);
  });
});
