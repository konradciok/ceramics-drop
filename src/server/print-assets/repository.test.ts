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
  for (const m of ['eq', 'select']) {
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

  it('returns null when the variant row is absent (inactive/unknown key)', async () => {
    setupResolve({
      assignment: { asset_id: 'a1', print_fulfilment_assets: READY_ASSET },
      variant: null,
    });
    const { resolvePrintAsset } = await import('./repository');
    expect(await resolvePrintAsset('fap01', '50x70_unframed')).toBeNull();
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
