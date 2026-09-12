import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadProductResponses } from './mapping';

vi.mock('@/lib/print-assets', () => ({ signPrintAssetUrl: vi.fn(async (id: string) => `https://x.test/signed/${id}`) }));

function makeTable(data: unknown[]) {
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  builder.select = self;
  builder.in = self;
  builder.order = self;
  builder.eq = self;
  builder.then = (resolve: (v: { data: unknown[]; error: null }) => void) => resolve({ data, error: null });
  return builder;
}

function fakeSupabase(tables: Record<string, unknown[]>): SupabaseClient {
  return { from: (table: string) => makeTable(tables[table] ?? []) } as unknown as SupabaseClient;
}

const env = { PRINT_ASSET_TOKEN_SECRET: 'secret' };

describe('loadProductResponses', () => {
  it('uses the latest product_drafts payload when one exists', async () => {
    const supabase = fakeSupabase({
      products: [{ id: 'prd_1', type: 'ceramic', category_slug: 'kubki', num: '01', measure: '', price_pln: null, price_eur: null, price_gbp: null, drop_id: null, status: 'draft', published_revision: null }],
      product_drafts: [
        { product_id: 'prd_1', revision: 2, payload: { type: 'ceramic', images: ['a.webp'] } },
        { product_id: 'prd_1', revision: 1, payload: { type: 'ceramic', images: ['old.webp'] } },
      ],
      product_variants: [],
      product_media: [],
      piece_state: [],
    });
    const result = await loadProductResponses(supabase, env, ['prd_1']);
    const product = result.get('prd_1')!;
    expect(product.revision).toBe(2);
    expect(product.thumbnail).toBe('a.webp');
  });

  it('synthesizes a revision-0 draft for a legacy product with no product_drafts row', async () => {
    const supabase = fakeSupabase({
      products: [{ id: 'k01', type: 'ceramic', category_slug: 'kubki', num: '01', measure: '9x8', price_pln: 120, price_eur: 28, price_gbp: 24, drop_id: null, status: 'active', published_revision: null }],
      product_drafts: [],
      product_variants: [],
      product_media: [{ product_id: 'k01', url: 'https://x.test/k01.webp', is_primary: true }],
      piece_state: [],
    });
    const result = await loadProductResponses(supabase, env, ['k01']);
    const product = result.get('k01')!;
    expect(product.revision).toBe(0);
    expect(product.publishedRevision).toBe(0);
    expect(product.draft.type).toBe('ceramic');
    expect((product.draft as { pricePln: number }).pricePln).toBe(12000);
    expect(product.thumbnail).toBe('https://x.test/k01.webp');
  });

  it('synthesizes sizes/frameColours/mountAvailable from multiple legacy print_variants rows, excluding inactive ones', async () => {
    const supabase = fakeSupabase({
      products: [{ id: 'fap002', type: 'print', category_slug: 'fine-art-prints', num: '02', measure: '', price_pln: null, price_eur: null, price_gbp: null, drop_id: null, status: 'active', published_revision: null }],
      product_drafts: [],
      product_variants: [
        { product_id: 'fap002', variant_key: '30x40:false:false:none', axes: { size: '30x40', framed: false, mount: false, frameColour: 'none' }, active: true },
        { product_id: 'fap002', variant_key: '30x40:true:false:black', axes: { size: '30x40', framed: true, mount: false, frameColour: 'black' }, active: true },
        { product_id: 'fap002', variant_key: '50x70:true:true:natural', axes: { size: '50x70', framed: true, mount: true, frameColour: 'natural' }, active: true },
        { product_id: 'fap002', variant_key: '70x100:false:false:none', axes: { size: '70x100', framed: false, mount: false, frameColour: 'none' }, active: false },
      ],
      product_media: [{ product_id: 'fap002', url: 'https://x.test/fap002.webp', is_primary: true }],
      piece_state: [],
    });
    const result = await loadProductResponses(supabase, env, ['fap002']);
    const draft = result.get('fap002')!.draft as { sizes: string[]; frameColours: string[]; mountAvailable: boolean };
    expect([...draft.sizes].sort()).toEqual(['30x40', '50x70']);
    expect([...draft.frameColours].sort()).toEqual(['black', 'natural']);
    expect(draft.mountAvailable).toBe(true);
  });

  it('leaves publishedRevision null for a draft-status legacy product with no product_drafts row', async () => {
    const supabase = fakeSupabase({
      products: [{ id: 'fap099', type: 'print', category_slug: 'fine-art-prints', num: '99', measure: '', price_pln: null, price_eur: null, price_gbp: null, drop_id: null, status: 'draft', published_revision: null }],
      product_drafts: [],
      product_variants: [],
      product_media: [],
      piece_state: [],
    });
    const result = await loadProductResponses(supabase, env, ['fap099']);
    expect(result.get('fap099')!.publishedRevision).toBeNull();
  });

  it('derives reserved/sold/showroom availability from piece_state', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const supabase = fakeSupabase({
      products: [
        { id: 'k01', type: 'ceramic', category_slug: 'kubki', num: '01', measure: '', price_pln: 100, price_eur: 20, price_gbp: 18, drop_id: null, status: 'active', published_revision: 1 },
        { id: 'k02', type: 'ceramic', category_slug: 'kubki', num: '02', measure: '', price_pln: 100, price_eur: 20, price_gbp: 18, drop_id: null, status: 'active', published_revision: 1 },
        { id: 'k03', type: 'ceramic', category_slug: 'kubki', num: '03', measure: '', price_pln: 100, price_eur: 20, price_gbp: 18, drop_id: null, status: 'active', published_revision: 1 },
      ],
      product_drafts: [
        { product_id: 'k01', revision: 1, payload: { type: 'ceramic', images: ['a.webp'] } },
        { product_id: 'k02', revision: 1, payload: { type: 'ceramic', images: ['b.webp'] } },
        { product_id: 'k03', revision: 1, payload: { type: 'ceramic', images: ['c.webp'] } },
      ],
      product_variants: [],
      product_media: [],
      piece_state: [
        { product_id: 'k01', status: 'reserved', reserved_until: future, showroom: false },
        { product_id: 'k02', status: 'sold', reserved_until: null, showroom: false },
        { product_id: 'k03', status: 'available', reserved_until: null, showroom: true },
      ],
    });
    const result = await loadProductResponses(supabase, env, ['k01', 'k02', 'k03']);
    expect(result.get('k01')!.availability).toBe('reserved');
    expect(result.get('k02')!.availability).toBe('sold');
    expect(result.get('k03')!.availability).toBe('showroom');
  });

  it('signs a URL only for ready/retired print_fulfilment_assets, not staged', async () => {
    const supabase = fakeSupabase({
      products: [{ id: 'fap001', type: 'print', category_slug: 'fine-art-prints', num: '01', measure: '', price_pln: null, price_eur: null, price_gbp: null, drop_id: null, status: 'active', published_revision: 1 }],
      product_drafts: [{ product_id: 'fap001', revision: 1, payload: { type: 'print', images: ['a.webp'] } }],
      product_variants: [],
      product_media: [],
      piece_state: [],
      print_variant_asset_assignments: [{ product_id: 'fap001', variant_key: '30x40:false:false:none', asset_id: 'asset-ready' }],
      print_fulfilment_assets: [
        { id: 'asset-ready', product_id: 'fap001', revision: 'r1', status: 'ready', profile_key: '3600x4800' },
        { id: 'asset-staged', product_id: 'fap001', revision: 'r2', status: 'staged', profile_key: '3600x4800' },
      ],
    });
    const result = await loadProductResponses(supabase, env, ['fap001']);
    const proofs = result.get('fap001')!.proofs;
    expect(proofs.find((p) => p.id === 'asset-ready')!.url).toBe('https://x.test/signed/asset-ready');
    expect(proofs.find((p) => p.id === 'asset-staged')!.url).toBeNull();
    expect(proofs.find((p) => p.id === 'asset-staged')!.variantKey).toBe('3600x4800');
  });
});
