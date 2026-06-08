import { describe, it, expect } from 'vitest';
import {
  getProducts,
  getProductsByCategory,
  getProductById,
  resolveCartProducts,
  resolveKnownProducts,
  CATEGORY_ORDER,
} from './products';

describe('getProducts', () => {
  it('builds exactly 96 pieces', () => {
    expect(getProducts()).toHaveLength(96);
  });

  it('has the right count per category', () => {
    const counts = { kubki: 26, wazony: 9, 'wazony-duze': 10, talerzyki: 15, 'talerze-duze': 12, 'duze-michy': 7, 'miski-falowane': 17 };
    for (const slug of CATEGORY_ORDER) {
      expect(getProductsByCategory(slug)).toHaveLength(counts[slug]);
    }
  });

  it('marks no pieces as sold (DB is now the source of truth)', () => {
    const sold = getProducts().filter((p) => p.sold);
    expect(sold).toHaveLength(0);
  });

  it('maps image files, honouring the skip lists', () => {
    expect(getProductById('k01')!.image).toBe('/uploads/kubek-1.webp');
    expect(getProductById('v01')!.image).toBe('/uploads/waza-mala-1.webp');
    expect(getProductById('d02')!.image).toBe('/uploads/waza-duza-3.webp');
    expect(getProductById('p12')!.image).toBe('/uploads/talerz-duzy-13.webp');
    expect(getProductById('w16')!.image).toBe('/uploads/miski-falowane-16.webp');
    // Newly added pieces
    expect(getProductById('k26')!.image).toBe('/uploads/kubek-26.webp');
    expect(getProductById('v09')!.image).toBe('/uploads/waza-mala-9.webp');
    expect(getProductById('d10')!.image).toBe('/uploads/waza-duza-11.webp');
    expect(getProductById('b07')!.image).toBe('/uploads/duza-micha-7.webp');
    expect(getProductById('w17')!.image).toBe('/uploads/miski-falowane-17.webp');
  });

  it('sets price, measure and noteIndex from the category', () => {
    const k = getProductById('k01')!;
    expect(k).toMatchObject({ price: 90, measure: '9 × 9 cm · 300 ml', num: '01', noteIndex: 0 });
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

  it('includes previously-sold ids when sold flag is false (DB is source of truth)', () => {
    // All products now have sold: false; resolveCartProducts only filters unknown ids and sold items.
    expect(resolveCartProducts(['k01', 'k04']).map((p) => p.id)).toEqual(['k01', 'k04']);
  });
});

describe('resolveKnownProducts', () => {
  it('keeps sold pieces when resolving ids for post-purchase analytics', () => {
    expect(resolveKnownProducts(['k01', 'k04']).map((p) => p.id)).toEqual(['k01', 'k04']);
  });

  it('still drops unknown ids', () => {
    expect(resolveKnownProducts(['k01', 'nope']).map((p) => p.id)).toEqual(['k01']);
  });
});
