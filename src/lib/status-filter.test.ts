import { describe, it, expect } from 'vitest';
import { filterByStatus, purchasableFirst, STATUS_FILTERS, tileSaleBadge } from './status-filter';
import type { Product } from '@/lib/types';

const mk = (id: string, sold: boolean, showroom = false): Product => ({
  id,
  category: 'kubki',
  num: '01',
  image: `/uploads/${id}.webp`,
  price: 95,
  measure: '10 cm',
  sold,
  onlineAvailable: !sold && !showroom,
  showroom,
  dropId: 'drop-1',
  noteIndex: 0,
});

const products = [mk('k01', false), mk('k02', true), mk('k03', false)];

describe('filterByStatus', () => {
  it('all → returns every product unchanged', () => {
    expect(filterByStatus(products, 'all')).toEqual(products);
  });

  it('available → only unsold pieces', () => {
    expect(filterByStatus(products, 'available').map((p) => p.id)).toEqual(['k01', 'k03']);
  });

  it('sold → only sold pieces', () => {
    expect(filterByStatus(products, 'sold').map((p) => p.id)).toEqual(['k02']);
  });

  it('available → excludes showroom pieces (visible but not purchasable)', () => {
    const withShowroom = [mk('k01', false), mk('k02', false, true), mk('k03', false)];
    expect(filterByStatus(withShowroom, 'available').map((p) => p.id)).toEqual(['k01', 'k03']);
  });

  it('available → empty when everything is sold', () => {
    expect(filterByStatus([mk('k01', true), mk('k02', true)], 'available')).toEqual([]);
  });

  it('sold → empty when nothing is sold', () => {
    expect(filterByStatus([mk('k01', false)], 'sold')).toEqual([]);
  });

  it('STATUS_FILTERS lists the three views in control order', () => {
    expect(STATUS_FILTERS).toEqual(['all', 'available', 'sold']);
  });
});

describe('purchasableFirst', () => {
  it('moves sold and showroom pieces to the end, keeping each group in order', () => {
    const list = [mk('k01', true), mk('k02', false), mk('k03', false, true), mk('k04', false), mk('k05', true)];
    expect(purchasableFirst(list).map((p) => p.id)).toEqual(['k02', 'k04', 'k01', 'k03', 'k05']);
  });

  it('leaves a list with nothing sold unchanged', () => {
    const list = [mk('k01', false), mk('k02', false)];
    expect(purchasableFirst(list)).toEqual(list);
  });

  it('keeps a fully sold list in its order', () => {
    const list = [mk('k02', true), mk('k01', true)];
    expect(purchasableFirst(list).map((p) => p.id)).toEqual(['k02', 'k01']);
  });

  it('does not change the "available" view subset or its order', () => {
    expect(filterByStatus(purchasableFirst(products), 'available')).toEqual(filterByStatus(products, 'available'));
  });
});

describe('tileSaleBadge', () => {
  it('a purchasable piece carries no badge', () => {
    expect(tileSaleBadge(mk('k01', false))).toBeNull();
  });

  it('a sold piece is badged sold', () => {
    expect(tileSaleBadge(mk('k02', true))).toBe('sold');
  });

  it('a piece held by a checkout is badged reserved, not sold', () => {
    const reserved = { ...mk('k03', false), onlineAvailable: false, saleState: 'reserved' as const };
    expect(tileSaleBadge(reserved)).toBe('reserved');
  });

  it('the showroom badge wins over sold', () => {
    expect(tileSaleBadge(mk('k04', true, true))).toBe('showroom');
  });
});
