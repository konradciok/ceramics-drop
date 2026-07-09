import { describe, it, expect } from 'vitest';
import { filterByStatus, STATUS_FILTERS } from './status-filter';
import type { Product } from '@/lib/types';

const mk = (id: string, sold: boolean, showroom = false): Product => ({
  id,
  category: 'kubki',
  num: '01',
  image: `/uploads/${id}.webp`,
  price: 95,
  measure: '10 cm',
  sold,
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
