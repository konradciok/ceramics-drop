import { describe, expect, it, vi } from 'vitest';
import { mergeCeramicSaleState, getCeramicSaleState, type CeramicSaleState } from './ceramic-sale-state';
import type { Product } from './types';

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
  it('fails closed during an outage without deleting the gallery', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = await getCeramicSaleState();
    expect(failed.failed).toBe(true);
    expect(mergeCeramicSaleState([product], failed, now)[0]).toMatchObject({ id: 'k01', onlineAvailable: false, saleState: 'unknown' });
    log.mockRestore();
  });
});
