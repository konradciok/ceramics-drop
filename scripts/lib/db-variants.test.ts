import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { activeVariantDimensions } from './db-variants';

/** A thenable chain where every builder returns the chain; awaits resolve to
 *  `result`. `.maybeSingle()` resolves individually. Mirrors
 *  src/server/print-assets/repository.test.ts's mock. */
function makeChain(result: unknown): Record<string, unknown> {
  const chain: Record<string, unknown> = {
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve(result).catch(fn),
    finally: (fn: () => void) => Promise.resolve(result).finally(fn),
  };
  for (const m of ['eq', 'select']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain['maybeSingle'] = vi.fn().mockResolvedValue(result);
  return chain;
}

function makeSupabase({
  productStatus,
  variants,
}: {
  productStatus: { status: string } | null;
  variants: Array<{ variant_key: string; print_area_width_px: number | null; print_area_height_px: number | null }>;
}): SupabaseClient {
  const from = vi.fn().mockImplementation((table: string) => {
    if (table === 'products') return makeChain({ data: productStatus, error: null });
    if (table === 'product_variants') return makeChain({ data: variants, error: null });
    return makeChain({ data: null, error: null });
  });
  return { from } as unknown as SupabaseClient;
}

describe('activeVariantDimensions', () => {
  it('returns DB-seeded print-area pixels for every active variant', async () => {
    const supabase = makeSupabase({
      productStatus: { status: 'active' },
      variants: [
        { variant_key: '30x40:false:false:none', print_area_width_px: 3600, print_area_height_px: 4800 },
        { variant_key: '30x40:true:false:black', print_area_width_px: 3614, print_area_height_px: 4795 },
      ],
    });
    const result = await activeVariantDimensions(supabase, 'fap01');
    expect(result).toEqual([
      { variantKey: '30x40:false:false:none', w: 3600, h: 4800 },
      { variantKey: '30x40:true:false:black', w: 3614, h: 4795 },
    ]);
  });

  it('excludes a variant that is deactivated in the DB even if still in the code registry', async () => {
    // src/lib/prints.ts fap01 declares '30x40:true:false:brown' too, but the
    // DB query only returns rows with active=true — a deactivated variant
    // simply never appears here, so it never gets a derivative prepared.
    const supabase = makeSupabase({
      productStatus: { status: 'active' },
      variants: [
        { variant_key: '30x40:false:false:none', print_area_width_px: 3600, print_area_height_px: 4800 },
      ],
    });
    const result = await activeVariantDimensions(supabase, 'fap01');
    expect(result.map((v) => v.variantKey)).toEqual(['30x40:false:false:none']);
    expect(result.some((v) => v.variantKey === '30x40:true:false:brown')).toBe(false);
  });

  it('falls back to PRODIGI_SKU_MAP when DB print-area pixels are not yet seeded', async () => {
    const supabase = makeSupabase({
      productStatus: { status: 'active' },
      variants: [
        { variant_key: '30x40:false:false:none', print_area_width_px: null, print_area_height_px: null },
      ],
    });
    const result = await activeVariantDimensions(supabase, 'fap01');
    expect(result).toEqual([{ variantKey: '30x40:false:false:none', w: 3600, h: 4800 }]);
  });

  it('throws for an unknown product id', async () => {
    const supabase = makeSupabase({ productStatus: null, variants: [] });
    await expect(activeVariantDimensions(supabase, 'nope')).rejects.toThrow(/unknown print product/i);
  });

  it('throws for a draft product', async () => {
    const supabase = makeSupabase({ productStatus: { status: 'draft' }, variants: [] });
    await expect(activeVariantDimensions(supabase, 'fap04')).rejects.toThrow(/not active/i);
  });

  it('throws for a hidden product', async () => {
    const supabase = makeSupabase({ productStatus: { status: 'hidden' }, variants: [] });
    await expect(activeVariantDimensions(supabase, 'fap01')).rejects.toThrow(/not active/i);
  });

  it('throws when the product has zero active variants', async () => {
    const supabase = makeSupabase({ productStatus: { status: 'active' }, variants: [] });
    await expect(activeVariantDimensions(supabase, 'fap01')).rejects.toThrow(/no active variants/i);
  });

  it('throws when an active variant has no seeded dims and no PRODIGI_SKU_MAP entry', async () => {
    const supabase = makeSupabase({
      productStatus: { status: 'active' },
      variants: [{ variant_key: 'not-a-real-key', print_area_width_px: null, print_area_height_px: null }],
    });
    await expect(activeVariantDimensions(supabase, 'fap01')).rejects.toThrow(/no print-area pixels seeded/i);
  });
});
