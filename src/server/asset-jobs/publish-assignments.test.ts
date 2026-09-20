import { describe, it, expect } from 'vitest';
import { buildJobPublishAssignments } from './publish-assignments';
import type { VariantDimension } from '@/lib/print-assets-prepare';

describe('buildJobPublishAssignments', () => {
  it('maps every active variant to its profile asset id when all are ready', () => {
    const variants: VariantDimension[] = [
      { variantKey: 'small:false:false:none', w: 60, h: 80 },
      { variantKey: 'medium:false:false:none', w: 60, h: 80 },
      { variantKey: 'large:false:false:none', w: 100, h: 150 },
    ];
    const readyAssetIdByProfileKey = new Map([
      ['60x80', 'asset-1'],
      ['100x150', 'asset-2'],
    ]);
    const result = buildJobPublishAssignments(variants, readyAssetIdByProfileKey);

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.assignments).toEqual(
      expect.arrayContaining([
        { variant_key: 'small:false:false:none', asset_id: 'asset-1' },
        { variant_key: 'medium:false:false:none', asset_id: 'asset-1' },
        { variant_key: 'large:false:false:none', asset_id: 'asset-2' },
      ]),
    );
    expect(result.assignments).toHaveLength(3);
  });

  it('reports missing profiles instead of throwing, when a variant has no ready asset yet', () => {
    const variants: VariantDimension[] = [
      { variantKey: 'small:false:false:none', w: 60, h: 80 },
      { variantKey: 'large:false:false:none', w: 100, h: 150 },
    ];
    // Only the 60x80 profile has a ready asset — 100x150 is missing, e.g.
    // because it belongs to a different ratio this upload never covered
    // (the documented multi-ratio-product limitation).
    const readyAssetIdByProfileKey = new Map([['60x80', 'asset-1']]);
    const result = buildJobPublishAssignments(variants, readyAssetIdByProfileKey);

    expect(result.kind).toBe('missing_profiles');
    if (result.kind !== 'missing_profiles') throw new Error('expected missing_profiles');
    expect(result.missingVariantKeys).toEqual(['large:false:false:none']);
  });
});
