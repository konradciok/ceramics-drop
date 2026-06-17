import { describe, it, expect } from 'vitest';
import {
  getProducts,
  getPublicProducts,
  getProductsByCategory,
  getProductById,
  resolveCartProducts,
  resolveKnownProducts,
  isCategoryHidden,
  CATEGORY_ORDER,
  VISIBLE_CATEGORY_ORDER,
  HIDDEN_CATEGORIES,
} from './products';

describe('getProducts', () => {
  it('builds exactly 125 pieces (104 prior catalogue + 21 new talerze-srednie s03–s23)', () => {
    expect(getProducts()).toHaveLength(125);
  });

  it('has the right count per category', () => {
    const counts = { kubki: 29, wazony: 9, 'wazony-srednie': 5, 'wazony-duze': 4, talerzyki: 14, 'talerze-srednie': 39, 'talerze-duze': 9, 'duze-michy': 6, 'miski-falowane': 10 };
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
    // Newly added pieces
    expect(getProductById('k23')!.image).toBe('/uploads/kubek-23.webp');
    expect(getProductById('k26')!.image).toBe('/uploads/kubek-26.webp');
    expect(getProductById('b07')!.image).toBe('/uploads/duza-micha-7.webp');
    expect(getProductById('w17')!.image).toBe('/uploads/miski-falowane-17.webp');
    // talerze-srednie
    expect(getProductById('t16')!.image).toBe('/uploads/talerz-maly-16.webp');
    expect(getProductById('s01')!.image).toBe('/uploads/sredni-talerz-17.webp');
    expect(getProductById('s02')!.image).toBe('/uploads/sredni-talerz-18.webp');
    expect(getProductById('s03')!.image).toBe('/uploads/sredni-talerz-19.webp');
    expect(getProductById('s23')!.image).toBe('/uploads/sredni-talerz-39.webp');
    // segunda partia
    expect(getProductById('c01')!.image).toBe('/uploads/kubek-kolejny-nr-1.webp');
    expect(getProductById('c04')!.image).toBe('/uploads/kubek-kolejny-nr-4.webp');
    expect(getProductById('k27')!.image).toBe('/uploads/kubek-31.webp');
    expect(getProductById('k27')!.num).toBe('25');
    expect(getProductById('k27')!.noteIndex).toBe(24);
    expect(getProductById('u01')!.image).toBe('/uploads/sredni-wazon-234.webp');
    expect(getProductById('g01')!.image).toBe('/uploads/duza-waza-122.webp');
    expect(getProductById('h01')!.image).toBe('/uploads/duza-miska-23.webp');
  });

  it('sets price, measure and noteIndex from the category', () => {
    const k = getProductById('k01')!;
    expect(k).toMatchObject({ price: 95, measure: '8 × 8 × 10 cm', num: '01', noteIndex: 0 });
    // t16 was recategorised from talerzyki → talerze-srednie; must carry the new price/measure
    const t16 = getProductById('t16')!;
    expect(t16).toMatchObject({ price: 119, measure: '⌀ 18 cm', category: 'talerze-srednie' });
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

describe('June inventory review', () => {
  it('removes withdrawn pieces from the catalogue', () => {
    for (const id of ['k15', 'k16', 'v08', 'd04', 'd08', 't03', 'p04', 'p06', 'p11', 'b05', 'b06', 'w01', 'w02', 'w04', 'w10', 'w11', 'w13', 'w16']) {
      expect(getProductById(id), id).toBeUndefined();
    }
  });

  it('recategorises t16–t31 and s01–s23 to talerze-srednie', () => {
    for (const id of ['t16', 't31', 's01', 's02', 's03', 's23']) {
      expect(getProductById(id)!.category, id).toBe('talerze-srednie');
    }
    // talerzyki retains t01–t15 minus t03 = 14 pieces
    expect(getProductById('t01')!.category).toBe('talerzyki');
    expect(getProductById('t15')!.category).toBe('talerzyki');
  });

  it('keeps stable ids while resequencing display numbers', () => {
    // p10 (the one ordered/sold piece) keeps its id but moves to Nº08 after p04/p06 are removed.
    const p10 = getProductById('p10')!;
    expect(p10.category).toBe('talerze-duze');
    expect(p10.image).toBe('/uploads/talerz-duzy-10.webp');
    expect(p10.num).toBe('08');
  });

  it('splits the large vases into medium + large and swaps the movers', () => {
    // dawne duże d01–d03,d05 → średnie
    for (const id of ['d01', 'd02', 'd03', 'd05']) {
      expect(getProductById(id)!.category, id).toBe('wazony-srednie');
    }
    // d06,d07,d09 stay large; v09 reverted back to small vases (artist confirmed)
    for (const id of ['d06', 'd07', 'd09']) {
      expect(getProductById(id)!.category, id).toBe('wazony-duze');
    }
    expect(getProductById('v09')!.category, 'v09').toBe('wazony');
    // d10 drops down to the small vases
    expect(getProductById('d10')!.category).toBe('wazony');
    expect(getProductById('v09')!.image).toBe('/uploads/waza-mala-9.webp');
    expect(getProductById('d10')!.image).toBe('/uploads/waza-duza-11.webp');
  });

  it('merges second photos into the target piece gallery', () => {
    expect(getProductById('w12')!.gallery).toEqual(['/uploads/miski-falowane-11.webp']);
    expect(getProductById('w14')!.gallery).toEqual(['/uploads/miski-falowane-13.webp']);
    expect(getProductById('w15')!.gallery).toEqual(['/uploads/miski-falowane-16.webp']);
  });

  it('leaves non-gallery pieces without a gallery field', () => {
    expect(getProductById('k01')!.gallery).toBeUndefined();
  });
});

describe('hidden categories', () => {
  it('hides exactly the five withdrawn families', () => {
    expect([...HIDDEN_CATEGORIES].sort()).toEqual(
      ['duze-michy', 'miski-falowane', 'talerze-duze', 'wazony-duze', 'wazony-srednie'].sort(),
    );
    expect(isCategoryHidden('wazony-duze')).toBe(true);
    expect(isCategoryHidden('kubki')).toBe(false);
  });

  it('VISIBLE_CATEGORY_ORDER keeps only the four public families, in order', () => {
    expect(VISIBLE_CATEGORY_ORDER).toEqual(['kubki', 'wazony', 'talerzyki', 'talerze-srednie']);
  });

  it('getPublicProducts drops every hidden-family piece, keeps the rest', () => {
    const pub = getPublicProducts();
    // The invariant that matters: no hidden category survives in the public set.
    expect(pub.every((p) => !isCategoryHidden(p.category))).toBe(true);
    // Count derived from category sizes so a future catalogue edit can't make
    // this drift silently (vs. a hardcoded magic number).
    const hiddenCount = [...HIDDEN_CATEGORIES].reduce(
      (n, slug) => n + getProductsByCategory(slug).length,
      0,
    );
    expect(pub).toHaveLength(getProducts().length - hiddenCount);
    // The full catalogue is untouched — hidden pieces still resolve by id.
    expect(getProductById('w03')!.category).toBe('miski-falowane');
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

  it('drops pieces in hidden (withdrawn) families', () => {
    // w03 = miski-falowane, g01 = wazony-duze — both hidden; k01 stays.
    expect(resolveCartProducts(['k01', 'w03', 'g01']).map((p) => p.id)).toEqual(['k01']);
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
