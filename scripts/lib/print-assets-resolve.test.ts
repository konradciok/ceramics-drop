import { describe, it, expect } from 'vitest';
import {
  buildSandboxMatrix,
  galleryR2Key,
  latestReadyByProfile,
  profileKeyFromPx,
  type ReadyAssetRow,
} from './print-assets-resolve';

describe('profileKeyFromPx', () => {
  it('formats width x height', () => {
    expect(profileKeyFromPx(8400, 12000)).toBe('8400x12000');
  });
});

describe('galleryR2Key', () => {
  it('builds the gallery object prefix', () => {
    expect(galleryR2Key('fap01', 'hero', 'fap-01.webp')).toBe(
      'prints/fap01/gallery/hero/fap-01.webp',
    );
  });
});

describe('latestReadyByProfile', () => {
  it('keeps the first row per profile when sorted by verified_at desc', () => {
    const rows: ReadyAssetRow[] = [
      { id: 'new-8400', profile_key: '8400x12000', revision: '2026-07-13-r2', verified_at: '2026-07-13T10:00:00Z' },
      { id: 'old-8400', profile_key: '8400x12000', revision: '2026-07-12-r1', verified_at: '2026-07-12T10:00:00Z' },
      { id: 'only-3600', profile_key: '3600x4800', revision: '2026-07-12-r1', verified_at: '2026-07-12T09:00:00Z' },
    ];
    const byProfile = latestReadyByProfile(rows);
    expect(byProfile.get('8400x12000')?.id).toBe('new-8400');
    expect(byProfile.get('3600x4800')?.id).toBe('only-3600');
  });
});

describe('buildSandboxMatrix', () => {
  it('covers seven distinct print-area profiles', () => {
    const matrix = buildSandboxMatrix();
    expect(matrix).toHaveLength(7);
    expect(new Set(matrix.map((r) => r.profileKey)).size).toBe(7);
  });

  it('matches the legacy hardcoded SKU set', () => {
    const matrix = buildSandboxMatrix();
    expect(matrix.map((r) => r.sku).sort()).toEqual([
      'GLOBAL-CFP-12X16',
      'GLOBAL-CFPM-12X16',
      'GLOBAL-CFPM-20X28',
      'GLOBAL-CFPM-28X40',
      'GLOBAL-FAP-12X16',
      'GLOBAL-FAP-20X28',
      'GLOBAL-FAP-28X40',
    ]);
  });

  it('builds mount attributes for mounted framed rows', () => {
    const mounted = buildSandboxMatrix().find((r) => r.variantKey === '30x40:true:true:black');
    expect(mounted?.attributes).toEqual({
      color: 'black',
      mount: '2.4mm',
      mountColor: 'Snow white',
    });
  });
});
