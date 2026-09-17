import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { assetRevisionForUpload, isPrintRatio, loadActivePrintVariants, selectProfilesForRatio } from './profiles';

const UPLOAD_ID = '11111111-1111-1111-1111-111111111111';

describe('assetRevisionForUpload', () => {
  it('is deterministic in the upload id so a retried job reuses the same revision', () => {
    expect(assetRevisionForUpload(UPLOAD_ID)).toBe(`cms-${UPLOAD_ID}`);
    expect(assetRevisionForUpload(UPLOAD_ID)).toBe(assetRevisionForUpload(UPLOAD_ID));
  });

  it('is a safe single path segment (it becomes part of the content-addressed r2_key)', () => {
    expect(assetRevisionForUpload(UPLOAD_ID)).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe('isPrintRatio', () => {
  it('accepts the four catalogue ratios and nothing else', () => {
    for (const ratio of ['3x4', '5x7', '7x10', '2x3']) expect(isPrintRatio(ratio)).toBe(true);
    for (const junk of ['4x3', '', '3x4 ', 'A4']) expect(isPrintRatio(junk)).toBe(false);
  });
});

/** Minimal thenable Supabase chain — same helper shape as process-job.test.ts. */
function makeSupabase(handlers: Record<string, unknown>): SupabaseClient {
  return { from: (table: string) => handlers[table] } as unknown as SupabaseClient;
}

function productsTable(result: { data: unknown; error: unknown }) {
  return { select: () => ({ eq: () => ({ maybeSingle: async () => result }) }) };
}

function variantsTable(result: { data: unknown; error: unknown }) {
  const chain = {
    eq: vi.fn(() => chain),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej),
  };
  return { select: () => chain };
}

describe('loadActivePrintVariants', () => {
  it('returns active variants with their seeded print-area pixels', async () => {
    const supabase = makeSupabase({
      products: productsTable({ data: { status: 'active' }, error: null }),
      product_variants: variantsTable({
        data: [
          { variant_key: '30x40:false:false:black', print_area_width_px: 3600, print_area_height_px: 4800 },
          { variant_key: '50x70:false:false:black', print_area_width_px: 6000, print_area_height_px: 8400 },
        ],
        error: null,
      }),
    });
    expect(await loadActivePrintVariants(supabase, 'print-001')).toEqual({
      kind: 'ok',
      variants: [
        { variantKey: '30x40:false:false:black', w: 3600, h: 4800 },
        { variantKey: '50x70:false:false:black', w: 6000, h: 8400 },
      ],
    });
  });

  it('rejects an unknown product', async () => {
    const supabase = makeSupabase({ products: productsTable({ data: null, error: null }) });
    expect(await loadActivePrintVariants(supabase, 'nope')).toEqual({ kind: 'invalid', message: expect.stringContaining('unknown product') });
  });

  it('rejects a non-active product rather than staging assets for a draft', async () => {
    const supabase = makeSupabase({ products: productsTable({ data: { status: 'draft' }, error: null }) });
    expect(await loadActivePrintVariants(supabase, 'print-001')).toEqual({
      kind: 'invalid',
      message: expect.stringContaining('is not active'),
    });
  });

  it('rejects a product with no active print variants', async () => {
    const supabase = makeSupabase({
      products: productsTable({ data: { status: 'active' }, error: null }),
      product_variants: variantsTable({ data: [], error: null }),
    });
    expect(await loadActivePrintVariants(supabase, 'print-001')).toMatchObject({ kind: 'invalid' });
  });

  it('filters out the temporarily-unsellable mount variants (variant_key segment 3 === "true")', async () => {
    const supabase = makeSupabase({
      products: productsTable({ data: { status: 'active' }, error: null }),
      product_variants: variantsTable({
        data: [
          { variant_key: '30x40:true:true:black', print_area_width_px: 2400, print_area_height_px: 3200 },
          { variant_key: '30x40:false:false:black', print_area_width_px: 3600, print_area_height_px: 4800 },
        ],
        error: null,
      }),
    });
    expect(await loadActivePrintVariants(supabase, 'print-001')).toEqual({
      kind: 'ok',
      variants: [{ variantKey: '30x40:false:false:black', w: 3600, h: 4800 }],
    });
  });

  it('fails closed on an active variant with no seeded print area — never falls back to the code registry', async () => {
    const supabase = makeSupabase({
      products: productsTable({ data: { status: 'active' }, error: null }),
      product_variants: variantsTable({
        data: [{ variant_key: '30x40:false:false:black', print_area_width_px: null, print_area_height_px: null }],
        error: null,
      }),
    });
    expect(await loadActivePrintVariants(supabase, 'print-001')).toEqual({
      kind: 'invalid',
      message: expect.stringContaining('no seeded print_area_*_px'),
    });
  });

  it('throws (→ queue retry) on a transient DB error rather than failing the job terminally', async () => {
    const supabase = makeSupabase({ products: productsTable({ data: null, error: { message: 'db down' } }) });
    await expect(loadActivePrintVariants(supabase, 'print-001')).rejects.toBeTruthy();
  });
});

describe('selectProfilesForRatio', () => {
  const VARIANTS = [
    { variantKey: '30x40:false:false:black', w: 3600, h: 4800 }, // 3x4
    { variantKey: '30x40:true:false:black', w: 3600, h: 4800 }, // same profile, shares one derivative
    { variantKey: '50x70:false:false:black', w: 6000, h: 8400 }, // 5x7
  ];

  it('returns one profile per distinct dimension set for the requested ratio', () => {
    expect(selectProfilesForRatio(VARIANTS, '3x4')).toEqual({
      kind: 'ok',
      profiles: [
        {
          profileKey: '3600x4800',
          w: 3600,
          h: 4800,
          variantKeys: ['30x40:false:false:black', '30x40:true:false:black'],
        },
      ],
    });
  });

  it('ignores profiles belonging to other ratios', () => {
    const selection = selectProfilesForRatio(VARIANTS, '5x7');
    expect(selection).toMatchObject({ kind: 'ok' });
    if (selection.kind !== 'ok') throw new Error('unreachable');
    expect(selection.profiles.map((p) => p.profileKey)).toEqual(['6000x8400']);
  });

  it('rejects a ratio no active variant needs', () => {
    expect(selectProfilesForRatio(VARIANTS, '2x3')).toEqual({
      kind: 'invalid',
      message: expect.stringContaining('no active variant'),
    });
  });

  it('rejects (never silently skips) a profile whose dimensions match no known print ratio', () => {
    expect(selectProfilesForRatio([{ variantKey: 'weird', w: 1000, h: 1000 }], '3x4')).toEqual({
      kind: 'invalid',
      message: expect.stringContaining('No known print ratio'),
    });
  });
});
