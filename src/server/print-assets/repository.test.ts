import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFrom } = vi.hoisted(() => ({ mockFrom: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabaseAdmin: () => ({ from: mockFrom }) }));

/** A thenable chain where every builder returns the chain; awaits resolve to
 *  `result`. `.maybeSingle()` resolves individually (for the resolve() path).
 *  Mirrors process-job.test.ts. */
function makeChain(result: unknown): Record<string, unknown> {
  const chain: Record<string, unknown> = {
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(res, rej),
    catch: (fn: (e: unknown) => unknown) => Promise.resolve(result).catch(fn),
    finally: (fn: () => void) => Promise.resolve(result).finally(fn),
  };
  for (const m of ['eq', 'select', 'order']) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain['maybeSingle'] = vi.fn().mockResolvedValue(result);
  return chain;
}

/** Wire the two tables `resolvePrintAsset` reads (assignment+asset, variant). */
function setupResolve({
  assignment,
  variant,
}: {
  assignment: Record<string, unknown> | null;
  variant: Record<string, unknown> | null;
}) {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'print_variant_asset_assignments')
      return makeChain({ data: assignment, error: null });
    if (table === 'product_variants') return makeChain({ data: variant, error: null });
    return makeChain({ data: null, error: null });
  });
}

/** Wire the two list queries `getPrintAssetReadiness` reads. */
function setupReadiness({
  variants,
  assignments,
}: {
  variants: Record<string, unknown>[];
  assignments: Record<string, unknown>[];
}) {
  mockFrom.mockImplementation((table: string) => {
    if (table === 'product_variants') return makeChain({ data: variants, error: null });
    if (table === 'print_variant_asset_assignments')
      return makeChain({ data: assignments, error: null });
    return makeChain({ data: null, error: null });
  });
}

/** Wire a single `print_fulfilment_assets` row (or null) for fulfilment/route helpers. */
function setupSingleAsset(row: Record<string, unknown> | null) {
  mockFrom.mockImplementation(() => makeChain({ data: row, error: null }));
}

/** Wire a DB error for a single-table query. */
function setupSingleAssetError() {
  mockFrom.mockImplementation(() => makeChain({ data: null, error: { message: 'connection reset' } }));
}

beforeEach(() => vi.clearAllMocks());

// ── resolvePrintAsset ─────────────────────────────────────────────────────────

describe('resolvePrintAsset', () => {
  const READY_ASSET = {
    id: 'a1',
    r2_key: 'prints/fap01/r1/3600x4800-deadbeef.jpg',
    sha256: 'deadbeef',
    content_type: 'image/jpeg',
    width_px: 3600,
    height_px: 4800,
    status: 'ready',
  };
  const VARIANT_MATCHED = { print_area_width_px: 3600, print_area_height_px: 4800 };

  it('returns the mapped asset when assigned, ready, and dim-matched', async () => {
    setupResolve({
      assignment: { asset_id: 'a1', print_fulfilment_assets: READY_ASSET },
      variant: VARIANT_MATCHED,
    });
    const { resolvePrintAsset } = await import('./repository');
    expect(await resolvePrintAsset('fap01', '50x70_unframed')).toEqual({
      assetId: 'a1',
      r2Key: 'prints/fap01/r1/3600x4800-deadbeef.jpg',
      sha256: 'deadbeef',
      contentType: 'image/jpeg',
      widthPx: 3600,
      heightPx: 4800,
    });
  });

  it('returns null when no assignment exists', async () => {
    setupResolve({ assignment: null, variant: VARIANT_MATCHED });
    const { resolvePrintAsset } = await import('./repository');
    expect(await resolvePrintAsset('fap01', '50x70_unframed')).toBeNull();
  });

  for (const status of ['staged', 'retired', 'revoked'] as const) {
    it(`returns null when asset status is ${status}`, async () => {
      setupResolve({
        assignment: { asset_id: 'a1', print_fulfilment_assets: { ...READY_ASSET, status } },
        variant: VARIANT_MATCHED,
      });
      const { resolvePrintAsset } = await import('./repository');
      expect(await resolvePrintAsset('fap01', '50x70_unframed')).toBeNull();
    });
  }

  it('returns null on width dimension mismatch', async () => {
    setupResolve({
      assignment: { asset_id: 'a1', print_fulfilment_assets: { ...READY_ASSET, width_px: 9999 } },
      variant: VARIANT_MATCHED,
    });
    const { resolvePrintAsset } = await import('./repository');
    expect(await resolvePrintAsset('fap01', '50x70_unframed')).toBeNull();
  });

  it('returns null when the variant print_area_*_px is null (unseeded)', async () => {
    setupResolve({
      assignment: { asset_id: 'a1', print_fulfilment_assets: READY_ASSET },
      variant: { print_area_width_px: null, print_area_height_px: null },
    });
    const { resolvePrintAsset } = await import('./repository');
    expect(await resolvePrintAsset('fap01', '50x70_unframed')).toBeNull();
  });

  it('returns null when the variant row is absent (unknown key)', async () => {
    setupResolve({
      assignment: { asset_id: 'a1', print_fulfilment_assets: READY_ASSET },
      variant: null,
    });
    const { resolvePrintAsset } = await import('./repository');
    expect(await resolvePrintAsset('fap01', '50x70_unframed')).toBeNull();
  });

  it('scopes variant lookup to active rows only', async () => {
    const variantChain = makeChain({ data: null, error: null });
    mockFrom.mockImplementation((table: string) => {
      if (table === 'print_variant_asset_assignments') {
        return makeChain({
          data: { asset_id: 'a1', print_fulfilment_assets: READY_ASSET },
          error: null,
        });
      }
      if (table === 'product_variants') return variantChain;
      return makeChain({ data: null, error: null });
    });
    const { resolvePrintAsset } = await import('./repository');
    expect(await resolvePrintAsset('fap01', '50x70_unframed')).toBeNull();
    expect(variantChain.eq).toHaveBeenCalledWith('active', true);
  });
});

// ── getPrintAssetReadiness ────────────────────────────────────────────────────

describe('getPrintAssetReadiness', () => {
  const DIMS = { print_area_width_px: 3600, print_area_height_px: 4800 };
  const READY = { status: 'ready', width_px: 3600, height_px: 4800 };

  it('is ready with no missing when every active variant has a usable assignment', async () => {
    setupReadiness({
      variants: [
        { variant_key: 'a', ...DIMS },
        { variant_key: 'b', ...DIMS },
      ],
      assignments: [
        { variant_key: 'a', print_fulfilment_assets: READY },
        { variant_key: 'b', print_fulfilment_assets: READY },
      ],
    });
    const { getPrintAssetReadiness } = await import('./repository');
    expect(await getPrintAssetReadiness('fap01')).toEqual({
      productId: 'fap01',
      ready: true,
      totalActiveVariants: 2,
      missing: [],
    });
  });

  it('reports missing keys when some variants lack a usable assignment', async () => {
    setupReadiness({
      variants: [
        { variant_key: 'a', ...DIMS },
        { variant_key: 'b', ...DIMS },
        { variant_key: 'c', ...DIMS },
      ],
      // a covered; b has no assignment at all; c revoked.
      assignments: [
        { variant_key: 'a', print_fulfilment_assets: READY },
        { variant_key: 'c', print_fulfilment_assets: { ...READY, status: 'revoked' } },
      ],
    });
    const { getPrintAssetReadiness } = await import('./repository');
    const r = await getPrintAssetReadiness('fap01');
    expect(r.ready).toBe(false);
    expect(r.totalActiveVariants).toBe(3);
    expect(r.missing).toEqual(['b', 'c']);
  });

  it('is vacuously ready when there are zero active variants', async () => {
    setupReadiness({ variants: [], assignments: [] });
    const { getPrintAssetReadiness } = await import('./repository');
    expect(await getPrintAssetReadiness('fap01')).toEqual({
      productId: 'fap01',
      ready: true,
      totalActiveVariants: 0,
      missing: [],
    });
  });

  it('counts a revoked assignment as missing', async () => {
    setupReadiness({
      variants: [{ variant_key: 'a', ...DIMS }],
      assignments: [
        { variant_key: 'a', print_fulfilment_assets: { ...READY, status: 'revoked' } },
      ],
    });
    const { getPrintAssetReadiness } = await import('./repository');
    expect(await getPrintAssetReadiness('fap01')).toEqual({
      productId: 'fap01',
      ready: false,
      totalActiveVariants: 1,
      missing: ['a'],
    });
  });

  it('counts a dimension-mismatched assignment as missing', async () => {
    setupReadiness({
      variants: [{ variant_key: 'a', ...DIMS }],
      assignments: [
        { variant_key: 'a', print_fulfilment_assets: { ...READY, width_px: 9999 } },
      ],
    });
    const { getPrintAssetReadiness } = await import('./repository');
    expect(await getPrintAssetReadiness('fap01')).toEqual({
      productId: 'fap01',
      ready: false,
      totalActiveVariants: 1,
      missing: ['a'],
    });
  });

  it('counts an unseeded variant (null print_area_*_px) as missing', async () => {
    setupReadiness({
      variants: [{ variant_key: 'a', print_area_width_px: null, print_area_height_px: null }],
      assignments: [{ variant_key: 'a', print_fulfilment_assets: READY }],
    });
    const { getPrintAssetReadiness } = await import('./repository');
    const r = await getPrintAssetReadiness('fap01');
    expect(r.ready).toBe(false);
    expect(r.missing).toEqual(['a']);
  });

  it('sorts missing keys for stable output', async () => {
    setupReadiness({
      variants: [
        { variant_key: 'z', ...DIMS },
        { variant_key: 'a', ...DIMS },
        { variant_key: 'm', ...DIMS },
      ],
      assignments: [],
    });
    const { getPrintAssetReadiness } = await import('./repository');
    expect((await getPrintAssetReadiness('fap01')).missing).toEqual(['a', 'm', 'z']);
  });
});

// ── getPrintAssetCoverage ─────────────────────────────────────────────────────

describe('getPrintAssetCoverage', () => {
  const DIMS = { print_area_width_px: 3600, print_area_height_px: 4800 };
  const READY_ASSET = {
    id: 'asset-1',
    revision: '2026-07-10-r1',
    status: 'ready',
    width_px: 3600,
    height_px: 4800,
    verified_at: '2026-07-10T12:00:00.000Z',
  };

  function setupCoverage({
    variants,
    assignments,
  }: {
    variants: Record<string, unknown>[];
    assignments: Record<string, unknown>[];
  }) {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'product_variants') return makeChain({ data: variants, error: null });
      if (table === 'print_variant_asset_assignments')
        return makeChain({ data: assignments, error: null });
      return makeChain({ data: null, error: null });
    });
  }

  it('returns per-variant asset detail and readiness summary', async () => {
    setupCoverage({
      variants: [
        { variant_key: 'a', ...DIMS },
        { variant_key: 'b', ...DIMS },
      ],
      assignments: [
        { variant_key: 'a', print_fulfilment_assets: READY_ASSET },
        { variant_key: 'b', print_fulfilment_assets: { ...READY_ASSET, status: 'revoked' } },
      ],
    });
    const { getPrintAssetCoverage } = await import('./repository');
    expect(await getPrintAssetCoverage('fap01')).toEqual({
      productId: 'fap01',
      ready: false,
      totalActiveVariants: 2,
      missing: ['b'],
      variants: [
        {
          variantKey: 'a',
          printAreaWidthPx: 3600,
          printAreaHeightPx: 4800,
          usable: true,
          asset: {
            id: 'asset-1',
            revision: '2026-07-10-r1',
            widthPx: 3600,
            heightPx: 4800,
            status: 'ready',
            verifiedAt: '2026-07-10T12:00:00.000Z',
          },
        },
        {
          variantKey: 'b',
          printAreaWidthPx: 3600,
          printAreaHeightPx: 4800,
          usable: false,
          asset: {
            id: 'asset-1',
            revision: '2026-07-10-r1',
            widthPx: 3600,
            heightPx: 4800,
            status: 'revoked',
            verifiedAt: '2026-07-10T12:00:00.000Z',
          },
        },
      ],
    });
  });

  it('marks variants with no assignment as missing with null asset', async () => {
    setupCoverage({
      variants: [{ variant_key: 'a', ...DIMS }],
      assignments: [],
    });
    const { getPrintAssetCoverage } = await import('./repository');
    const coverage = await getPrintAssetCoverage('fap01');
    expect(coverage.missing).toEqual(['a']);
    expect(coverage.variants[0]).toMatchObject({
      variantKey: 'a',
      usable: false,
      asset: null,
    });
  });
});

// ── getAssetForFulfilment ─────────────────────────────────────────────────────

describe('getAssetForFulfilment', () => {
  const BASE = {
    id: 'asset-1',
    r2_key: 'prints/fap01/rev1/4800x7200-abc.jpg',
    sha256: 'a'.repeat(64),
    revision: '2026-07-10-r1',
    status: 'ready',
  };

  it('returns the record for a ready asset', async () => {
    setupSingleAsset(BASE);
    const { getAssetForFulfilment } = await import('./repository');
    expect(await getAssetForFulfilment('asset-1')).toEqual({
      id: 'asset-1',
      r2Key: BASE.r2_key,
      sha256: BASE.sha256,
      revision: BASE.revision,
      status: 'ready',
    });
  });

  it('returns the record for a retired asset (historical orders still valid)', async () => {
    setupSingleAsset({ ...BASE, status: 'retired' });
    const { getAssetForFulfilment } = await import('./repository');
    const result = await getAssetForFulfilment('asset-1');
    expect(result?.status).toBe('retired');
  });

  it('returns null for a staged asset (no R2 object yet, route would 404)', async () => {
    setupSingleAsset({ ...BASE, status: 'staged' });
    const { getAssetForFulfilment } = await import('./repository');
    expect(await getAssetForFulfilment('asset-1')).toBeNull();
  });

  it('returns null for a revoked asset', async () => {
    setupSingleAsset({ ...BASE, status: 'revoked' });
    const { getAssetForFulfilment } = await import('./repository');
    expect(await getAssetForFulfilment('asset-1')).toBeNull();
  });

  it('returns null when the row is absent', async () => {
    setupSingleAsset(null);
    const { getAssetForFulfilment } = await import('./repository');
    expect(await getAssetForFulfilment('asset-1')).toBeNull();
  });

  it('throws on a DB error (caller marks job failed_retryable)', async () => {
    setupSingleAssetError();
    const { getAssetForFulfilment } = await import('./repository');
    await expect(getAssetForFulfilment('asset-1')).rejects.toThrow('connection reset');
  });
});

// ── resolveAssetR2Key ─────────────────────────────────────────────────────────

describe('resolveAssetR2Key', () => {
  const BASE = {
    r2_key: 'prints/fap01/rev1/4800x7200-abc.jpg',
    content_type: 'image/jpeg',
    status: 'ready',
  };

  it('returns the r2Key and contentType for a ready asset', async () => {
    setupSingleAsset(BASE);
    const { resolveAssetR2Key } = await import('./repository');
    expect(await resolveAssetR2Key('asset-1')).toEqual({
      kind: 'found',
      r2Key: BASE.r2_key,
      contentType: 'image/jpeg',
      status: 'ready',
    });
  });

  it('returns the record for a retired asset', async () => {
    setupSingleAsset({ ...BASE, status: 'retired' });
    const { resolveAssetR2Key } = await import('./repository');
    expect(await resolveAssetR2Key('asset-1')).toMatchObject({ kind: 'found', status: 'retired' });
  });

  it('returns not_found for a staged asset', async () => {
    setupSingleAsset({ ...BASE, status: 'staged' });
    const { resolveAssetR2Key } = await import('./repository');
    expect(await resolveAssetR2Key('asset-1')).toEqual({ kind: 'not_found' });
  });

  it('returns revoked for a revoked asset', async () => {
    setupSingleAsset({ ...BASE, status: 'revoked' });
    const { resolveAssetR2Key } = await import('./repository');
    expect(await resolveAssetR2Key('asset-1')).toEqual({ kind: 'revoked' });
  });

  it('returns not_found when the row is absent', async () => {
    setupSingleAsset(null);
    const { resolveAssetR2Key } = await import('./repository');
    expect(await resolveAssetR2Key('asset-1')).toEqual({ kind: 'not_found' });
  });

  it('throws on a DB error', async () => {
    setupSingleAssetError();
    const { resolveAssetR2Key } = await import('./repository');
    await expect(resolveAssetR2Key('asset-1')).rejects.toThrow('connection reset');
  });
});
