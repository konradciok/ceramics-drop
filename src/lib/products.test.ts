import { describe, it, expect } from 'vitest';
import {
  getProducts,
  getProductsByCategory,
  getProductById,
  resolveCartProducts,
  CATEGORY_ORDER,
} from './products';

describe('getProducts', () => {
  it('builds exactly 88 pieces', () => {
    expect(getProducts()).toHaveLength(88);
  });

  it('has the right count per category', () => {
    const counts = { kubki: 22, wazony: 8, 'wazony-duze': 9, talerzyki: 15, 'talerze-duze': 12, 'duze-michy': 6, 'miski-falowane': 16 };
    for (const slug of CATEGORY_ORDER) {
      expect(getProductsByCategory(slug)).toHaveLength(counts[slug]);
    }
  });

  it('marks exactly the five sold pieces', () => {
    const sold = getProducts().filter((p) => p.sold).map((p) => p.id).sort();
    expect(sold).toEqual(['k04', 'k11', 'k19', 'v02', 'v06']);
  });

  it('maps image files, honouring the skip lists', () => {
    expect(getProductById('k01')!.image).toBe('/uploads/kubek-1.webp');
    expect(getProductById('v01')!.image).toBe('/uploads/waza-mala-1.webp');
    expect(getProductById('d02')!.image).toBe('/uploads/waza-duza-3.webp');
    expect(getProductById('p12')!.image).toBe('/uploads/talerz-duzy-13.webp');
    expect(getProductById('w16')!.image).toBe('/uploads/miski-falowane-16.webp');
  });

  it('sets price, measure and noteIndex from the category', () => {
    const k = getProductById('k01')!;
    expect(k).toMatchObject({ price: 22, measure: '9 × 9 cm · 300 ml', num: '01', noteIndex: 0 });
    expect(getProductById('d02')!.noteIndex).toBe(1);
  });

  it('caches the registry — same reference across calls', () => {
    expect(getProducts()).toBe(getProducts());
    expect(getProductsByCategory('kubki')).toBe(getProductsByCategory('kubki'));
  });

  it('returns the registry instance from lookups', () => {
    const all = getProducts();
    expect(getProductById('k01')).toBe(all.find((p) => p.id === 'k01'));
  });
});

describe('resolveCartProducts', () => {
  it('resolves ids to products, preserving order', () => {
    expect(resolveCartProducts(['v01', 'k01']).map((p) => p.id)).toEqual(['v01', 'k01']);
  });

  it('drops unknown ids', () => {
    expect(resolveCartProducts(['k01', 'nope']).map((p) => p.id)).toEqual(['k01']);
  });

  it('drops sold ids so sold pieces never reach the cart', () => {
    expect(resolveCartProducts(['k01', 'k04']).map((p) => p.id)).toEqual(['k01']);
  });
});
