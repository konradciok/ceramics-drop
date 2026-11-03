import { describe, expect, it, vi } from 'vitest';
import { buildAssetName, computeAssetRatio, loadAssetList, mapPrintFulfilmentAssetToAsset } from './assets-mapping';

vi.mock('@/lib/print-assets', () => ({
  signPrintAssetUrl: vi.fn(async (assetId: string) => `https://signed.example/${assetId}`),
}));

describe('computeAssetRatio', () => {
  it('reduces a common print size to its simplest ratio', () => {
    expect(computeAssetRatio(3600, 4800)).toBe('3:4');
  });

  it('reduces a square image to 1:1', () => {
    expect(computeAssetRatio(2000, 2000)).toBe('1:1');
  });

  it('handles dimensions already in lowest terms', () => {
    expect(computeAssetRatio(5, 7)).toBe('5:7');
  });
});

describe('buildAssetName', () => {
  it('combines product, print-revision label and profile key when present', () => {
    expect(buildAssetName({ product_id: 'fap01', revision: '2026-07-11-r1', profile_key: '3600x4800' })).toBe(
      'fap01 · 2026-07-11-r1 · 3600x4800',
    );
  });

  it('omits the profile key segment when null', () => {
    expect(buildAssetName({ product_id: 'fap01', revision: '2026-07-11-r1', profile_key: null })).toBe('fap01 · 2026-07-11-r1');
  });
});

describe('mapPrintFulfilmentAssetToAsset', () => {
  it('maps a ready/retired row to the Asset contract shape', () => {
    const row = { id: 'a1', product_id: 'fap01', revision: '2026-07-11-r1', profile_key: null, width_px: 3600, height_px: 4800 };
    expect(mapPrintFulfilmentAssetToAsset(row, 'https://signed.example/a1', ['fap01:30x40:false:false:none'])).toEqual({
      id: 'a1',
      name: 'fap01 · 2026-07-11-r1',
      revision: 0,
      status: 'ready',
      ratio: '3:4',
      url: 'https://signed.example/a1',
      usages: ['fap01:30x40:false:false:none'],
      error: '',
    });
  });
});

// ---------------------------------------------------------------------------
// loadAssetList — thin I/O over ctx.supabase + env.PRINT_ASSET_TOKEN_SECRET.
// Never adminSupabase() / getCloudflareContext().
// ---------------------------------------------------------------------------

function fakeSupabase(config: { assets: unknown[]; assignments: unknown[] }) {
  return {
    from(table: string) {
      if (table === 'print_fulfilment_assets') {
        return {
          select: () => ({
            in: () => ({
              order: async () => ({ data: config.assets, error: null }),
            }),
          }),
        };
      }
      if (table === 'print_variant_asset_assignments') {
        return {
          select: async () => ({ data: config.assignments, error: null }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  } as never;
}

describe('loadAssetList', () => {
  const env = { PRINT_ASSET_TOKEN_SECRET: 'test-secret' };

  it('maps ready/retired rows, attaching usages from assignments', async () => {
    const items = await loadAssetList(
      fakeSupabase({
        assets: [
          { id: 'a1', product_id: 'fap01', revision: '2026-07-11-r1', profile_key: null, status: 'ready', width_px: 3600, height_px: 4800 },
          { id: 'a2', product_id: 'fap02', revision: '2026-08-01-r1', profile_key: '3000x4000', status: 'retired', width_px: 3000, height_px: 4000 },
        ],
        assignments: [{ product_id: 'fap01', variant_key: '30x40:false:false:none', asset_id: 'a1' }],
      }),
      env,
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ id: 'a1', status: 'ready', usages: ['fap01:30x40:false:false:none'] });
    expect(items[1]).toMatchObject({ id: 'a2', status: 'ready', usages: [] });
  });

  it('returns an empty list when there are no ready/retired assets', async () => {
    const items = await loadAssetList(fakeSupabase({ assets: [], assignments: [] }), env);
    expect(items).toEqual([]);
  });
});
