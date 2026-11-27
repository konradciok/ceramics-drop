import { describe, expect, it } from 'vitest';
import { VISIBLE_CATEGORY_ORDER } from '@/lib/products';
import { chipFamilies, parseFamilyParam, shopFamilyHref, showsShopEmptyNotice } from './shop-family';

describe('parseFamilyParam', () => {
  it('accepts a visible family slug', () => {
    expect(parseFamilyParam('kubki')).toBe('kubki');
  });

  it('accepts every visible family', () => {
    for (const slug of VISIBLE_CATEGORY_ORDER) expect(parseFamilyParam(slug)).toBe(slug);
  });

  it('ignores an unknown or empty value and keeps the full shop', () => {
    expect(parseFamilyParam('nonsense')).toBeUndefined();
    expect(parseFamilyParam('')).toBeUndefined();
    expect(parseFamilyParam(undefined)).toBeUndefined();
  });

  it('rejects a family that is not in the visible set (hidden family)', () => {
    // Injected allow-list: with `kubki` withdrawn it must not be filterable.
    const allowed = VISIBLE_CATEGORY_ORDER.filter((slug) => slug !== 'kubki');
    expect(parseFamilyParam('kubki', allowed)).toBeUndefined();
  });

  it('matches the exact slug (case-sensitive)', () => {
    expect(parseFamilyParam('Kubki')).toBeUndefined();
  });

  it('reads the first value of a repeated query param', () => {
    expect(parseFamilyParam(['wazony', 'kubki'])).toBe('wazony');
    expect(parseFamilyParam(['', 'kubki'])).toBeUndefined();
    expect(parseFamilyParam([])).toBeUndefined();
  });
});

describe('shopFamilyHref', () => {
  it('builds the no-JS filter link on /sklep', () => {
    expect(shopFamilyHref('kubki')).toBe('/sklep?rodzina=kubki');
  });
});

describe('chipFamilies', () => {
  const families = [
    { slug: 'kubki' as const, available: 2 },
    { slug: 'wazony' as const, available: 0 },
    { slug: 'talerzyki' as const, available: 1 },
  ];

  it('offers one chip per family with at least one piece available, in family order', () => {
    expect(chipFamilies(families).map((f) => f.slug)).toEqual(['kubki', 'talerzyki']);
  });

  it('offers no chip when nothing is available', () => {
    expect(chipFamilies(families.map((f) => ({ ...f, available: 0 })))).toEqual([]);
  });


});

describe('showsShopEmptyNotice', () => {
  it('shows the global notice only when the whole shop has nothing on sale', () => {
    expect(showsShopEmptyNotice(null, 0)).toBe(true);
    expect(showsShopEmptyNotice(undefined, 0)).toBe(true);
    expect(showsShopEmptyNotice(null, 3)).toBe(false);
  });

  it('never shows the shop-wide notice for a filtered family, even at zero', () => {
    // A family that sold out is not the whole shop being out of stock.
    expect(showsShopEmptyNotice('kubki', 0)).toBe(false);
    expect(showsShopEmptyNotice('kubki', 2)).toBe(false);
  });
});
