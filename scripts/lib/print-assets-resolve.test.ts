import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ loadSupabaseClient: vi.fn() }));
vi.mock('./script-env', () => ({ loadSupabaseClient: mocks.loadSupabaseClient }));

import {
  buildSandboxMatrix,
  galleryR2Key,
  latestReadyByProfile,
  parseReadyAssetDetail,
  parseReadyAssetRow,
  profileKeyFromPx,
  resolveLatestReadyAsset,
  resolveLatestReadyByProfile,
  type ReadyAssetRow,
} from './print-assets-resolve';
import { MOUNT_TEMPORARILY_DISABLED } from '../../src/lib/print-availability';

beforeEach(() => {
  mocks.loadSupabaseClient.mockReset();
});

/**
 * Minimal fake of the chained supabase query builder used by
 * resolveLatestReadyByProfile / resolveLatestReadyAsset. Actually sorts the
 * fixture rows by the recorded `.order(...)` calls (honouring `nullsFirst`),
 * so a test proves real selection — not just that `.order` was called with
 * the right arguments.
 */
function fakeReadyAssetsSupabase(rows: Record<string, unknown>[]) {
  const calls = {
    eq: [] as Array<[string, unknown]>,
    order: [] as Array<[string, { ascending?: boolean; nullsFirst?: boolean }]>,
    limit: undefined as number | undefined,
  };

  function compare(a: unknown, b: unknown, ascending: boolean, nullsFirst: boolean): number {
    const aNull = a === null || a === undefined;
    const bNull = b === null || b === undefined;
    if (aNull && bNull) return 0;
    if (aNull || bNull) {
      const nullSortsFirst = nullsFirst ? -1 : 1;
      return aNull ? nullSortsFirst : -nullSortsFirst;
    }
    if (a === b) return 0;
    const cmp = (a as string) < (b as string) ? -1 : 1;
    return ascending ? cmp : -cmp;
  }

  function resolveRows(): Record<string, unknown>[] {
    // Filtering (`.eq(...)`) is not under test here — fixtures are already the
    // candidate set a real `product_id`/`status`(/`revision`) filter would
    // return. Only sort + limit are exercised, which is what NULL ordering and
    // the sha256 tiebreaker actually affect.
    let result = [...rows].sort((a, b) => {
      for (const [col, opts] of calls.order) {
        const cmp = compare(a[col], b[col], opts.ascending ?? true, opts.nullsFirst ?? false);
        if (cmp !== 0) return cmp;
      }
      return 0;
    });
    if (calls.limit !== undefined) result = result.slice(0, calls.limit);
    return result;
  }

  const builder = {
    select() {
      return builder;
    },
    eq(col: string, val: unknown) {
      calls.eq.push([col, val]);
      return builder;
    },
    order(col: string, opts: { ascending?: boolean; nullsFirst?: boolean }) {
      calls.order.push([col, opts]);
      return builder;
    },
    limit(n: number) {
      calls.limit = n;
      return builder;
    },
    then(
      onFulfilled: (value: { data: Record<string, unknown>[]; error: null }) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) {
      return Promise.resolve({ data: resolveRows(), error: null }).then(onFulfilled, onRejected);
    },
  };

  const supabase = { from: () => builder };
  return { supabase, calls };
}

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
      { id: 'new-8400', profile_key: '8400x12000', revision: '2026-07-13-r2', sha256: 'a'.repeat(64), verified_at: '2026-07-13T10:00:00Z' },
      { id: 'old-8400', profile_key: '8400x12000', revision: '2026-07-12-r1', sha256: 'b'.repeat(64), verified_at: '2026-07-12T10:00:00Z' },
      { id: 'only-3600', profile_key: '3600x4800', revision: '2026-07-12-r1', sha256: 'c'.repeat(64), verified_at: '2026-07-12T09:00:00Z' },
    ];
    const byProfile = latestReadyByProfile(rows);
    expect(byProfile.get('8400x12000')?.id).toBe('new-8400');
    expect(byProfile.get('3600x4800')?.id).toBe('only-3600');
  });
});

describe('buildSandboxMatrix', () => {
  // The three CFPM (mounted) profiles drop out while passe-partout is temporarily
  // withdrawn (src/lib/print-availability.ts) — nothing can be ordered against
  // them, so the matrix must not place sandbox orders for them either.
  const EXPECTED_PROFILES = MOUNT_TEMPORARILY_DISABLED
    ? ['3600x4800', '6000x8400', '8400x12000']
    : ['2400x3600', '3600x4800', '4800x7200', '6000x8400', '7200x10800', '8400x12000'];
  const EXPECTED_SKUS = MOUNT_TEMPORARILY_DISABLED
    ? ['GLOBAL-FAP-12X16', 'GLOBAL-FAP-20X28', 'GLOBAL-FAP-28X40']
    : [
        'GLOBAL-CFPM-12X16',
        'GLOBAL-CFPM-20X28',
        'GLOBAL-CFPM-28X40',
        'GLOBAL-FAP-12X16',
        'GLOBAL-FAP-20X28',
        'GLOBAL-FAP-28X40',
      ];

  it('covers every distinct sellable asset profile (30x40 black-framed shares the unframed asset, decision #6)', () => {
    const matrix = buildSandboxMatrix();
    expect(matrix).toHaveLength(EXPECTED_PROFILES.length);
    expect(new Set(matrix.map((r) => r.profileKey)).size).toBe(EXPECTED_PROFILES.length);
    expect(matrix.map((r) => r.profileKey).sort()).toEqual(EXPECTED_PROFILES);
  });

  it('matches the asset-contract SKU set (no GLOBAL-CFP-* — those profiles collapse into the FAP/CFPM ones)', () => {
    const matrix = buildSandboxMatrix();
    expect(matrix.map((r) => r.sku).sort()).toEqual(EXPECTED_SKUS);
  });

  it.runIf(MOUNT_TEMPORARILY_DISABLED)('places no sandbox order for a mounted variant', () => {
    expect(buildSandboxMatrix().some((r) => r.variantKey.split(':')[2] === 'true')).toBe(false);
  });

  it.runIf(!MOUNT_TEMPORARILY_DISABLED)('builds mount attributes for mounted framed rows', () => {
    const mounted = buildSandboxMatrix().find((r) => r.variantKey === '30x40:true:true:black');
    expect(mounted?.attributes).toEqual({
      color: 'black',
      mount: '2.4mm',
      mountColor: 'Snow white',
    });
  });
});

const VALID_ROW = {
  id: '11111111-1111-1111-1111-111111111111',
  profile_key: '3600x4800',
  revision: '2026-07-13-r2',
  sha256: 'a'.repeat(64),
  verified_at: '2026-07-13T10:00:00Z',
};

describe('parseReadyAssetRow', () => {
  it('parses a valid row', () => {
    expect(parseReadyAssetRow(VALID_ROW)).toEqual(VALID_ROW);
  });

  it('accepts a null verified_at', () => {
    expect(parseReadyAssetRow({ ...VALID_ROW, verified_at: null }).verified_at).toBeNull();
  });

  it('rejects a non-object row', () => {
    expect(() => parseReadyAssetRow('nope')).toThrow(/object/);
  });

  it('rejects a non-UUID id', () => {
    expect(() => parseReadyAssetRow({ ...VALID_ROW, id: 'not-a-uuid' })).toThrow(/id/);
  });

  it('rejects an unsafe/traversal revision', () => {
    expect(() => parseReadyAssetRow({ ...VALID_ROW, revision: '../../etc' })).toThrow(/revision/);
  });

  it('rejects a traversal-shaped profile_key', () => {
    expect(() => parseReadyAssetRow({ ...VALID_ROW, profile_key: '../../etc/passwd' })).toThrow(/profile_key/);
  });

  it('rejects a non-hex/short sha256', () => {
    expect(() => parseReadyAssetRow({ ...VALID_ROW, sha256: 'not-a-hash' })).toThrow(/sha256/);
  });

  it('rejects an uppercase sha256 (must be lowercase hex)', () => {
    expect(() => parseReadyAssetRow({ ...VALID_ROW, sha256: 'A'.repeat(64) })).toThrow(/sha256/);
  });

  it('rejects a non-ISO verified_at', () => {
    expect(() => parseReadyAssetRow({ ...VALID_ROW, verified_at: 'not-a-date' })).toThrow(/verified_at/);
  });
});

describe('parseReadyAssetDetail', () => {
  const r2Key = `prints/fap01/2026-07-13-r2/3600x4800-${VALID_ROW.sha256}.jpg`;

  it('parses a valid detail row', () => {
    expect(parseReadyAssetDetail('fap01', { ...VALID_ROW, r2_key: r2Key })).toEqual({
      ...VALID_ROW,
      r2_key: r2Key,
    });
  });

  it('accepts a .png extension', () => {
    const pngKey = `prints/fap01/2026-07-13-r2/3600x4800-${VALID_ROW.sha256}.png`;
    expect(parseReadyAssetDetail('fap01', { ...VALID_ROW, r2_key: pngKey }).r2_key).toBe(pngKey);
  });

  it('rejects an r2_key built for a different product than the query filtered on', () => {
    expect(() => parseReadyAssetDetail('other-product', { ...VALID_ROW, r2_key: r2Key })).toThrow(/r2_key/);
  });

  it('rejects an r2_key embedding a different sha256 than the row (exact match, not a loose pattern)', () => {
    const wrongShaKey = `prints/fap01/2026-07-13-r2/3600x4800-${'d'.repeat(64)}.jpg`;
    expect(() => parseReadyAssetDetail('fap01', { ...VALID_ROW, r2_key: wrongShaKey })).toThrow(/r2_key/);
  });

  it('rejects an unsupported extension', () => {
    const gifKey = `prints/fap01/2026-07-13-r2/3600x4800-${VALID_ROW.sha256}.gif`;
    expect(() => parseReadyAssetDetail('fap01', { ...VALID_ROW, r2_key: gifKey })).toThrow(/r2_key/);
  });
});

describe('resolveLatestReadyByProfile', () => {
  it('queries with explicit NULL-last ordering and a sha256 tiebreaker, keeping the newest row per profile', async () => {
    const rows = [
      { id: '11111111-1111-1111-1111-111111111111', profile_key: '3600x4800', revision: 'r1', sha256: 'a'.repeat(64), verified_at: '2026-07-10T00:00:00Z' },
      { id: '22222222-2222-2222-2222-222222222222', profile_key: '3600x4800', revision: 'r2', sha256: 'b'.repeat(64), verified_at: '2026-07-13T00:00:00Z' },
      { id: '33333333-3333-3333-3333-333333333333', profile_key: '3600x4800', revision: 'r3', sha256: 'c'.repeat(64), verified_at: null },
    ];
    const { supabase, calls } = fakeReadyAssetsSupabase(rows);
    mocks.loadSupabaseClient.mockReturnValue(supabase);

    const byProfile = await resolveLatestReadyByProfile('fap01');

    expect(calls.order).toEqual([
      ['verified_at', { ascending: false, nullsFirst: false }],
      ['sha256', { ascending: false }],
    ]);
    // The newest verified_at (r2) wins over both an older verified row and a
    // null-verified_at row — proving nullsFirst:false actually sorts last.
    expect(byProfile.get('3600x4800')?.id).toBe('22222222-2222-2222-2222-222222222222');
  });

  it('rejects a malformed row (traversal-shaped profile_key) before returning', async () => {
    const rows = [
      {
        id: '11111111-1111-1111-1111-111111111111',
        profile_key: '../../etc/passwd',
        revision: 'r1',
        sha256: 'a'.repeat(64),
        verified_at: null,
      },
    ];
    const { supabase } = fakeReadyAssetsSupabase(rows);
    mocks.loadSupabaseClient.mockReturnValue(supabase);

    await expect(resolveLatestReadyByProfile('fap01')).rejects.toThrow(/profile_key/);
  });
});

describe('resolveLatestReadyAsset', () => {
  it('queries with explicit NULL-last ordering, a sha256 tiebreaker, and limit(1)', async () => {
    const older = {
      id: '11111111-1111-1111-1111-111111111111',
      profile_key: '3600x4800',
      revision: 'r1',
      sha256: 'a'.repeat(64),
      verified_at: '2026-07-10T00:00:00Z',
      r2_key: `prints/fap01/r1/3600x4800-${'a'.repeat(64)}.jpg`,
    };
    const newer = {
      id: '22222222-2222-2222-2222-222222222222',
      profile_key: '3600x4800',
      revision: 'r2',
      sha256: 'b'.repeat(64),
      verified_at: '2026-07-13T00:00:00Z',
      r2_key: `prints/fap01/r2/3600x4800-${'b'.repeat(64)}.jpg`,
    };
    const nullVerified = {
      id: '33333333-3333-3333-3333-333333333333',
      profile_key: '3600x4800',
      revision: 'r3',
      sha256: 'c'.repeat(64),
      verified_at: null,
      r2_key: `prints/fap01/r3/3600x4800-${'c'.repeat(64)}.jpg`,
    };
    const { supabase, calls } = fakeReadyAssetsSupabase([older, newer, nullVerified]);
    mocks.loadSupabaseClient.mockReturnValue(supabase);

    const asset = await resolveLatestReadyAsset('fap01', '3600x4800', undefined);

    expect(calls.order).toEqual([
      ['verified_at', { ascending: false, nullsFirst: false }],
      ['sha256', { ascending: false }],
    ]);
    expect(calls.limit).toBe(1);
    // Newest verified_at beats both the older row and the null-verified_at row.
    expect(asset.id).toBe(newer.id);
  });

  it('breaks a verified_at tie using sha256 descending', async () => {
    const same = '2026-07-13T00:00:00Z';
    const lower = {
      id: '11111111-1111-1111-1111-111111111111',
      profile_key: '3600x4800',
      revision: 'r1',
      sha256: 'a'.repeat(64),
      verified_at: same,
      r2_key: `prints/fap01/r1/3600x4800-${'a'.repeat(64)}.jpg`,
    };
    const higher = {
      id: '22222222-2222-2222-2222-222222222222',
      profile_key: '3600x4800',
      revision: 'r1',
      sha256: 'b'.repeat(64),
      verified_at: same,
      r2_key: `prints/fap01/r1/3600x4800-${'b'.repeat(64)}.jpg`,
    };
    const { supabase } = fakeReadyAssetsSupabase([lower, higher]);
    mocks.loadSupabaseClient.mockReturnValue(supabase);

    const asset = await resolveLatestReadyAsset('fap01', '3600x4800', undefined);
    expect(asset.id).toBe(higher.id);
  });

  it('rejects a malformed row (r2_key not matching its own product/revision/profile/sha256) before returning', async () => {
    const bad = {
      id: '11111111-1111-1111-1111-111111111111',
      profile_key: '3600x4800',
      revision: 'r1',
      sha256: 'a'.repeat(64),
      verified_at: null,
      r2_key: `prints/OTHER-PRODUCT/r1/3600x4800-${'a'.repeat(64)}.jpg`,
    };
    const { supabase } = fakeReadyAssetsSupabase([bad]);
    mocks.loadSupabaseClient.mockReturnValue(supabase);

    await expect(resolveLatestReadyAsset('fap01', '3600x4800', undefined)).rejects.toThrow(/r2_key/);
  });
});
