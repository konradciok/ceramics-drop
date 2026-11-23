import { describe, expect, it, vi } from 'vitest';
import { ceramicSaleFixtureEnabled, mergeCeramicSaleState, getCeramicSaleState, type CeramicSaleState } from './ceramic-sale-state';
import type { Product } from './types';
import { FALLBACK_CURRENT_DROP_ID } from './products';

vi.mock('./supabase', () => ({ getSupabaseAdmin: () => { throw new Error('offline'); } }));

const product: Product = { id: 'k01', category: 'kubki', num: '01', image: '/k01.webp', price: 100, measure: '10 cm', sold: false, dropId: 'drop-1', noteIndex: 0 };
const state: CeramicSaleState = {
  failed: false,
  drops: [{ id: 'drop-1', label: 'Drop 1', status: 'active' }],
  pieces: [{ product_id: 'k01', status: 'available', showroom: false, reserved_until: null }],
};
const now = Date.parse('2026-09-09T12:00:00Z');

describe('ceramic online availability', () => {
  it('allows an available public piece in an active drop', () => {
    expect(mergeCeramicSaleState([product], state, now)[0]).toMatchObject({ onlineAvailable: true, saleState: 'available' });
  });
  it.each(['ended', 'missing'])('keeps a piece visible but unavailable for a %s drop', (status) => {
    const drops = status === 'missing' ? [] : [{ ...state.drops[0], status }];
    expect(mergeCeramicSaleState([product], { ...state, drops }, now)[0]).toMatchObject({ id: 'k01', onlineAvailable: false, saleState: 'archive' });
  });
  it.each(['sold', 'unknown'])('blocks inventory status %s', (status) => {
    expect(mergeCeramicSaleState([product], { ...state, pieces: [{ ...state.pieces[0], status }] }, now)[0].onlineAvailable).toBe(false);
  });
  it.each(['draft', 'hidden', 'archived'] as const)('blocks catalogue status %s', (status) => {
    expect(mergeCeramicSaleState([{ ...product, status }], state, now)[0].onlineAvailable).toBe(false);
  });
  it('requires an inventory row and excludes retired showroom pieces', () => {
    expect(mergeCeramicSaleState([product], { ...state, pieces: [] }, now)[0].onlineAvailable).toBe(false);
    expect(mergeCeramicSaleState([product], { ...state, pieces: [{ ...state.pieces[0], showroom: true }] }, now)[0].onlineAvailable).toBe(false);
  });
  it.each([null, 'invalid', '2026-09-09T12:01:00Z'])('blocks live or unverifiable reservations (%s)', (reserved_until) => {
    expect(mergeCeramicSaleState([product], { ...state, pieces: [{ ...state.pieces[0], status: 'reserved', reserved_until }] }, now)[0]).toMatchObject({ onlineAvailable: false, saleState: 'reserved' });
  });
  it('allows an expired hold only while its drop is active', () => {
    const pieces = [{ ...state.pieces[0], status: 'reserved', reserved_until: '2026-09-09T11:59:00Z' }];
    expect(mergeCeramicSaleState([product], { ...state, pieces }, now)[0].onlineAvailable).toBe(true);
    expect(mergeCeramicSaleState([product], { ...state, pieces, drops: [] }, now)[0].onlineAvailable).toBe(false);
  });
  it.each([
    ['active', 'current'],
    ['ended', 'archive'],
    ['upcoming', 'hidden'],
  ] as const)('tags a piece of an %s drop as %s', (status, tier) => {
    const drops = [{ ...state.drops[0], status }];
    expect(mergeCeramicSaleState([product], { ...state, drops }, now)[0].dropTier).toBe(tier);
  });
  it('never sells a piece of an upcoming drop', () => {
    const drops = [{ ...state.drops[0], status: 'upcoming' }];
    expect(mergeCeramicSaleState([product], { ...state, drops }, now)[0].onlineAvailable).toBe(false);
  });
  it('fails closed during an outage without deleting the gallery', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = await getCeramicSaleState();
    expect(failed.failed).toBe(true);
    expect(mergeCeramicSaleState([product], failed, now)[0]).toMatchObject({ id: 'k01', onlineAvailable: false, saleState: 'unknown' });
    // Only the code-declared fallback drop stays listed while drops are unknown.
    expect(mergeCeramicSaleState([{ ...product, dropId: FALLBACK_CURRENT_DROP_ID }], failed, now)[0].dropTier).toBe('current');
    expect(mergeCeramicSaleState([{ ...product, dropId: 'drop-not-fallback' }], failed, now)[0].dropTier).toBe('hidden');
    log.mockRestore();
  });
});

describe('ceramicSaleFixtureEnabled (hermetic e2e only)', () => {
  const withEnv = (patch: Record<string, string | undefined>, fn: () => void) => {
    // Snapshot the live env on every call: a captured reference would be the
    // object a previous call already patched.
    const saved = { ...process.env };
    Object.assign(process.env, patch);
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete process.env[k];
    try {
      fn();
    } finally {
      process.env = saved;
    }
  };

  it('is off unless explicitly requested', () => {
    withEnv({ E2E_CERAMIC_SALE_FIXTURE: undefined, SUPABASE_URL: undefined }, () => {
      expect(ceramicSaleFixtureEnabled()).toBe(false);
    });
  });

  it('never turns on when a real backend is configured', () => {
    withEnv({ E2E_CERAMIC_SALE_FIXTURE: '1', SUPABASE_URL: 'https://x.supabase.co' }, () => {
      expect(ceramicSaleFixtureEnabled()).toBe(false);
    });
  });

  it('makes every registry piece available in an active drop when on', async () => {
    let state: CeramicSaleState | undefined;
    await new Promise<void>((resolve, reject) => {
      withEnv({ E2E_CERAMIC_SALE_FIXTURE: '1', SUPABASE_URL: undefined }, () => {
        expect(ceramicSaleFixtureEnabled()).toBe(true);
        getCeramicSaleState().then((s) => { state = s; resolve(); }, reject);
      });
    });
    expect(state!.failed).toBe(false);
    expect(state!.pieces.length).toBeGreaterThan(0);
    expect(state!.pieces.every((p) => p.status === 'available' && !p.showroom)).toBe(true);
    expect(state!.drops.every((d) => d.status === 'active')).toBe(true);
  });
});
