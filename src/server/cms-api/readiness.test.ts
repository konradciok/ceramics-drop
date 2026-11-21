import { describe, expect, it } from 'vitest';
import { computeReadiness, PRINTS_RETIRED_BLOCKER } from './readiness';
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

  it('blocks every print with the retired-prints blocker (prints left the store)', async () => {
    const supabase = fakeSupabase({});
    const result = await computeReadiness(supabase, printProduct);
    expect(result).toMatchObject({ revision: 1, ready: false, blockers: [PRINTS_RETIRED_BLOCKER] });
  });

  it('blocks a print even when it would previously have had every asset ready', async () => {
    const supabase = fakeSupabase({
      print_variant_asset_assignments: [
        { variant_key: '30x40:false:false:none', asset_id: 'a1' },
        { variant_key: '30x40:true:false:black', asset_id: 'a2' },
      ],
      print_fulfilment_assets: [
        { id: 'a1', status: 'ready', width_px: 3600, height_px: 4800 },
        { id: 'a2', status: 'ready', width_px: 3600, height_px: 4800 },
      ],
    });
    const result = await computeReadiness(supabase, printProduct);
    expect(result.ready).toBe(false);
    expect(result.blockers).toEqual([PRINTS_RETIRED_BLOCKER]);
  });
});
