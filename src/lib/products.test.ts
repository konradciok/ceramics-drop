import { describe, it, expect } from 'vitest';
import {
  getProducts,
  getProductsByCategory,
  getProductById,
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
    expect(getProductById('k01')!.image).toBe('/uploads/kubek-1.png');
    expect(getProductById('v01')!.image).toBe('/uploads/waza-mala-1.png');
    expect(getProductById('d02')!.image).toBe('/uploads/waza-duza-3.png');
    expect(getProductById('p12')!.image).toBe('/uploads/talerz-duzy-13.png');
    expect(getProductById('w16')!.image).toBe('/uploads/miski-falowane-16.png');
  });

  it('sets price, measure and noteIndex from the category', () => {
    const k = getProductById('k01')!;
    expect(k).toMatchObject({ price: 22, measure: '9 × 9 cm · 300 ml', num: '01', noteIndex: 0 });
    expect(getProductById('d02')!.noteIndex).toBe(1);
  });
});
