import { describe, it, expect, vi } from 'vitest';
vi.mock('./ceramic-sale-state', () => ({
  withCeramicSaleState: async (products: Product[]) => products.map((p) => ({ ...p, onlineAvailable: !p.sold && !p.showroom })),
}));
import {
  getProducts,
  getPublicProducts,
  getProductsByCategory,
  getProductById,
  resolveCartProducts,
  resolveKnownProducts,
  isCategoryHidden,
  isProductPublic,
  isProductListed,
  isProductPurchasable,
  dropLabelSuffix,
  orderFamily,
  CATEGORY_ORDER,
  VISIBLE_CATEGORY_ORDER,
  HIDDEN_CATEGORIES,
} from './products';
import type { Product } from './types';

/** Resolve the public (async) accessor once into an id lookup for terse assertions. */
async function byId(): Promise<Map<string, Product>> {
  return new Map((await getProducts()).map((p) => [p.id, p]));
}

describe('getProducts', () => {
  it('builds exactly 177 pieces (125 drop-1 + 52 drop-2)', async () => {
    expect(await getProducts()).toHaveLength(177);
    expect((await getProducts()).filter((p) => p.dropId === 'drop-1')).toHaveLength(125);
  });

  it('has the right count per category', async () => {
    const counts = { kubki: 47, wazony: 15, 'wazony-srednie': 11, 'wazony-duze': 9, talerzyki: 14, 'talerze-srednie': 39, 'talerze-duze': 9, 'duze-michy': 14, 'miski-falowane': 19, 'fine-art-prints': 0 };
    for (const slug of CATEGORY_ORDER) {
      expect(await getProductsByCategory(slug)).toHaveLength(counts[slug]);
    }
  });

  it('marks no pieces as sold (DB is now the source of truth)', async () => {
    const sold = (await getProducts()).filter((p) => p.sold);
    expect(sold).toHaveLength(0);
  });

  it('maps image files, honouring the skip lists', async () => {
    const m = await byId();
    expect(m.get('k01')!.image).toBe('/uploads/kubek-1.webp');
    expect(m.get('v01')!.image).toBe('/uploads/waza-mala-1.webp');
    expect(m.get('d02')!.image).toBe('/uploads/waza-duza-3.webp');
    expect(m.get('p12')!.image).toBe('/uploads/talerz-duzy-13.webp');
    // Newly added pieces
    expect(m.get('k23')!.image).toBe('/uploads/kubek-23.webp');
    expect(m.get('k26')!.image).toBe('/uploads/kubek-26.webp');
    expect(m.get('b07')!.image).toBe('/uploads/duza-micha-7.webp');
    expect(m.get('w17')!.image).toBe('/uploads/miski-falowane-17.webp');
    // talerze-srednie
    expect(m.get('t16')!.image).toBe('/uploads/talerz-maly-16.webp');
    expect(m.get('s01')!.image).toBe('/uploads/sredni-talerz-17.webp');
    expect(m.get('s02')!.image).toBe('/uploads/sredni-talerz-18.webp');
    expect(m.get('s03')!.image).toBe('/uploads/sredni-talerz-19.webp');
    expect(m.get('s23')!.image).toBe('/uploads/sredni-talerz-39.webp');
    // segunda partia
    expect(m.get('c01')!.image).toBe('/uploads/kubek-kolejny-nr-1.webp');
    expect(m.get('c04')!.image).toBe('/uploads/kubek-kolejny-nr-4.webp');
    expect(m.get('k27')!.image).toBe('/uploads/kubek-31.webp');
    expect(m.get('k27')!.num).toBe('25');
    expect(m.get('k27')!.noteIndex).toBe(24);
    expect(m.get('u01')!.image).toBe('/uploads/sredni-wazon-234.webp');
    expect(m.get('g01')!.image).toBe('/uploads/duza-waza-122.webp');
    expect(m.get('h01')!.image).toBe('/uploads/duza-miska-23.webp');
  });

  it('sets price, measure and noteIndex from the category', async () => {
    const m = await byId();
    const k = m.get('k01')!;
    expect(k).toMatchObject({ price: 95, measure: '8 × 8 × 10 cm', num: '01', noteIndex: 0 });
    // t16 was recategorised from talerzyki → talerze-srednie; must carry the new price/measure
    const t16 = m.get('t16')!;
    expect(t16).toMatchObject({ price: 119, measure: '⌀ 18 cm', category: 'talerze-srednie' });
  });

  it('caches the registry — same reference across calls', async () => {
    expect(await getProducts()).toBe(await getProducts());
    // getProductsByCategory now filters by isProductPublic, so it returns a fresh
    // (equal) array each call rather than the cached PRODUCTS_BY_CATEGORY ref.
    expect(await getProductsByCategory('kubki')).toEqual(await getProductsByCategory('kubki'));
  });

  it('adds live availability without mutating the registry instance', async () => {
    const all = await getProducts();
    expect(await getProductById('k01')).toMatchObject({ ...all.find((p) => p.id === 'k01'), onlineAvailable: true });
    expect(all.find((p) => p.id === 'k01')?.onlineAvailable).toBeUndefined();
  });
});

describe('June inventory review', () => {
  it('removes withdrawn pieces from the catalogue', async () => {
    const m = await byId();
    for (const id of ['k15', 'k16', 'v08', 'd04', 'd08', 't03', 'p04', 'p06', 'p11', 'b05', 'b06', 'w01', 'w02', 'w04', 'w10', 'w11', 'w13', 'w16']) {
      expect(m.get(id), id).toBeUndefined();
    }
  });

  it('recategorises t16–t31 and s01–s23 to talerze-srednie', async () => {
    const m = await byId();
    for (const id of ['t16', 't31', 's01', 's02', 's03', 's23']) {
      expect(m.get(id)!.category, id).toBe('talerze-srednie');
    }
    // talerzyki retains t01–t15 minus t03 = 14 pieces
    expect(m.get('t01')!.category).toBe('talerzyki');
    expect(m.get('t15')!.category).toBe('talerzyki');
  });

  it('keeps stable ids while resequencing display numbers', async () => {
    // p10 (the one ordered/sold piece) keeps its id but moves to Nº08 after p04/p06 are removed.
    const p10 = (await byId()).get('p10')!;
    expect(p10.category).toBe('talerze-duze');
    expect(p10.image).toBe('/uploads/talerz-duzy-10.webp');
    expect(p10.num).toBe('08');
  });

  it('splits the large vases into medium + large and swaps the movers', async () => {
    const m = await byId();
    // dawne duże d01–d03,d05 → średnie
    for (const id of ['d01', 'd02', 'd03', 'd05']) {
      expect(m.get(id)!.category, id).toBe('wazony-srednie');
    }
    // d06,d07,d09 stay large; v09 reverted back to small vases (artist confirmed)
    for (const id of ['d06', 'd07', 'd09']) {
      expect(m.get(id)!.category, id).toBe('wazony-duze');
    }
    expect(m.get('v09')!.category, 'v09').toBe('wazony');
    // d10 drops down to the small vases
    expect(m.get('d10')!.category).toBe('wazony');
    expect(m.get('v09')!.image).toBe('/uploads/waza-mala-9.webp');
    expect(m.get('d10')!.image).toBe('/uploads/waza-duza-11.webp');
  });

  it('merges second photos into the target piece gallery', async () => {
    const m = await byId();
    expect(m.get('w12')!.gallery).toEqual(['/uploads/miski-falowane-11.webp']);
    expect(m.get('w14')!.gallery).toEqual(['/uploads/miski-falowane-13.webp']);
    expect(m.get('w15')!.gallery).toEqual(['/uploads/miski-falowane-16.webp']);
  });

  it('leaves non-gallery pieces without a gallery field', async () => {
    expect((await byId()).get('k01')!.gallery).toBeUndefined();
  });
});

describe('hidden categories', () => {
  it('no families are withdrawn — all nine are public', () => {
    expect([...HIDDEN_CATEGORIES]).toHaveLength(0);
    expect(isCategoryHidden('wazony-duze')).toBe(false);
    expect(isCategoryHidden('kubki')).toBe(false);
  });

  it('VISIBLE_CATEGORY_ORDER contains all nine families in CATEGORY_ORDER', () => {
    expect(VISIBLE_CATEGORY_ORDER).toEqual([
      'kubki', 'wazony', 'wazony-srednie', 'wazony-duze',
      'talerzyki', 'talerze-srednie', 'talerze-duze', 'duze-michy', 'miski-falowane',
    ]);
  });

  it('getPublicProducts drops every hidden-family piece, keeps the rest', async () => {
    const pub = await getPublicProducts();
    // The invariant that matters: no hidden category survives in the public set.
    expect(pub.every((p) => !isCategoryHidden(p.category))).toBe(true);
    // Count derived from category sizes so a future catalogue edit can't make
    // this drift silently (vs. a hardcoded magic number).
    let hiddenCount = 0;
    for (const slug of HIDDEN_CATEGORIES) {
      hiddenCount += (await getProductsByCategory(slug)).length;
    }
    expect(pub).toHaveLength((await getProducts()).length - hiddenCount);
    // The full catalogue is untouched — hidden pieces still resolve by id.
    expect((await getProductById('w03'))!.category).toBe('miski-falowane');
  });
});

describe('resolveCartProducts', () => {
  it('resolves ids to products, preserving order', async () => {
    expect((await resolveCartProducts(['v01', 'k01'])).map((p) => p.id)).toEqual(['v01', 'k01']);
  });

  it('drops unknown ids', async () => {
    expect((await resolveCartProducts(['k01', 'nope'])).map((p) => p.id)).toEqual(['k01']);
  });

  it('includes previously-sold ids when sold flag is false (DB is source of truth)', async () => {
    // All products now have sold: false; resolveCartProducts only filters unknown ids and sold items.
    expect((await resolveCartProducts(['k01', 'k04'])).map((p) => p.id)).toEqual(['k01', 'k04']);
  });

  it('resolves pieces from formerly-withdrawn families (now public)', async () => {
    // w03 = miski-falowane, g01 = wazony-duze — both now public; all three resolve.
    expect((await resolveCartProducts(['k01', 'w03', 'g01'])).map((p) => p.id)).toEqual(['k01', 'w03', 'g01']);
  });
});

describe('resolveKnownProducts', () => {
  it('keeps sold pieces when resolving ids for post-purchase analytics', async () => {
    expect((await resolveKnownProducts(['k01', 'k04'])).map((p) => p.id)).toEqual(['k01', 'k04']);
  });

  it('still drops unknown ids', async () => {
    expect((await resolveKnownProducts(['k01', 'nope'])).map((p) => p.id)).toEqual(['k01']);
  });
});

describe('drop visibility', () => {
  const base = (): Product => ({ id: 'k01', category: 'kubki', num: '01', image: '/k.webp', price: 1, measure: '', sold: false, dropId: 'drop-1', noteIndex: 0 });

  it('lists only the live drop; an ended drop stays public (archive), an upcoming one is hidden', () => {
    expect([isProductPublic(base()), isProductListed(base())]).toEqual([true, true]);
    expect([isProductPublic({ ...base(), dropTier: 'current' }), isProductListed({ ...base(), dropTier: 'current' })]).toEqual([true, true]);
    expect([isProductPublic({ ...base(), dropTier: 'archive' }), isProductListed({ ...base(), dropTier: 'archive' })]).toEqual([true, false]);
    expect([isProductPublic({ ...base(), dropTier: 'hidden' }), isProductListed({ ...base(), dropTier: 'hidden' })]).toEqual([false, false]);
  });

  it('a withdrawn product status still wins over a live drop', () => {
    expect(isProductListed({ ...base(), dropTier: 'current', status: 'hidden' })).toBe(false);
  });
});

describe('dropId', () => {
  it('keeps every drop-1 piece in drop-1 and puts only the new batch in drop-2', async () => {
    const drop2 = (await getProducts()).filter((p) => p.dropId !== 'drop-1');
    expect(drop2.every((p) => p.dropId === 'drop-2')).toBe(true);
    const seq = (prefix: string, from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${String(from + i).padStart(2, '0')}`);
    // In CATEGORY_ORDER: kubki, wazony, wazony-srednie, wazony-duze, …, duze-michy, miski-falowane.
    expect(drop2.map((p) => p.id)).toEqual([
      ...seq('k', 28, 45),
      ...seq('v', 10, 15),
      ...seq('u', 2, 7),
      ...seq('d', 11, 15),
      ...seq('b', 8, 15),
      ...seq('w', 18, 26),
    ]);
  });

  it('gives every piece a unique id', async () => {
    const ids = (await getProducts()).map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('numbers pieces within their drop without shifting any existing number or note', async () => {
    // drop-1 pieces lead every family, so their per-(drop, family) numbering
    // must equal the old per-family position.
    for (const p of (await getProducts()).filter((x) => x.dropId === 'drop-1')) {
      expect(p.num, p.id).toBe(String(p.noteIndex + 1).padStart(2, '0'));
    }
  });

  it('restarts Nº at 01 for drop-2 and appends its notes after drop-1', async () => {
    const m = await byId();
    expect([m.get('v10')!.num, m.get('v10')!.noteIndex, m.get('v10')!.image]).toEqual(['01', 9, '/uploads/wazon-maly-1.webp']);
    expect([m.get('u07')!.num, m.get('u07')!.noteIndex, m.get('u07')!.category]).toEqual(['06', 10, 'wazony-srednie']);
    expect([m.get('d15')!.num, m.get('d15')!.noteIndex, m.get('d15')!.category]).toEqual(['05', 8, 'wazony-duze']);
    expect([m.get('k28')!.num, m.get('k28')!.noteIndex, m.get('k28')!.image]).toEqual(['01', 29, '/uploads/kubek-drop2-1.webp']);
    expect([m.get('b15')!.num, m.get('b15')!.noteIndex, m.get('b15')!.category]).toEqual(['08', 13, 'duze-michy']);
    expect([m.get('w26')!.num, m.get('w26')!.noteIndex, m.get('w26')!.image]).toEqual(['09', 18, '/uploads/miska-falowana-9.webp']);
  });

  it('appends a mover at the end of its own drop, so a later drop never shifts its note', () => {
    const piece = (id: string, dropId: string) => ({ id, dropId });
    const family = [piece('v01', 'drop-1'), piece('d10', 'drop-1'), piece('v02', 'drop-1'), piece('q01', 'drop-2')];
    const before = orderFamily(family.filter((p) => p.dropId === 'drop-1'), ['d10']).map((p) => p.id);
    const after = orderFamily(family, ['d10']).map((p) => p.id);
    expect(before).toEqual(['v01', 'v02', 'd10']);
    expect(after).toEqual(['v01', 'v02', 'd10', 'q01']);
    expect(after.indexOf('d10')).toBe(before.indexOf('d10'));
  });

  it('keeps drop-1 labels unsuffixed and marks later drops by id', () => {
    expect(dropLabelSuffix({ id: 'k01', dropId: 'drop-1' })).toBe('');
    expect(dropLabelSuffix({ id: 'q01', dropId: 'drop-2' })).toBe(' (q01)');
  });
});

describe('isProductPublic (status → visibility)', () => {
  it('treats a missing status (code registry) as active/public', async () => {
    const k01 = (await getProductById('k01'))!;
    expect(k01.status).toBeUndefined();
    expect(isProductPublic(k01)).toBe(true);
  });

  it('is public only for active status', () => {
    const base = { category: 'kubki' as const } as Parameters<typeof isProductPublic>[0];
    expect(isProductPublic({ ...base, status: 'active' })).toBe(true);
    expect(isProductPublic({ ...base, status: 'draft' })).toBe(false);
    expect(isProductPublic({ ...base, status: 'hidden' })).toBe(false);
    expect(isProductPublic({ ...base, status: 'archived' })).toBe(false);
  });

  it('keeps sold/showroom pieces public (they still render with a badge)', async () => {
    const k01 = (await getProductById('k01'))!;
    expect(isProductPublic({ ...k01, sold: true })).toBe(true);
    expect(isProductPublic({ ...k01, showroom: true })).toBe(true);
  });

  it('a non-active status also makes the product non-purchasable', async () => {
    const k01 = (await getProductById('k01'))!;
    expect(isProductPurchasable({ ...k01, status: 'hidden' })).toBe(false);
    expect(isProductPurchasable({ ...k01, status: 'active' })).toBe(true);
  });
});

describe('isProductPurchasable + showroom', () => {
  it('is purchasable when neither sold nor showroom', async () => {
    expect(isProductPurchasable((await getProductById('k01'))!)).toBe(true);
  });

  it('is NOT purchasable when showroom is set (even if not sold)', async () => {
    expect(isProductPurchasable({ ...(await getProductById('k01'))!, showroom: true })).toBe(false);
  });

  it('is NOT purchasable when sold', async () => {
    expect(isProductPurchasable({ ...(await getProductById('k01'))!, sold: true })).toBe(false);
  });

  it('drops showroom pieces from resolveCartProducts (stale localStorage guard)', async () => {
    const products = await resolveCartProducts(['k01', 'k02']);
    expect(products.map((p) => p.id)).toEqual(['k01', 'k02']);
    // Simulate a showroom overlay: resolveCartProducts reads the static registry,
    // so showroom pruning happens via /api/inventory + reserve_pieces at runtime;
    // this asserts the purchasability rule the overlay feeds into.
    expect(isProductPurchasable({ ...products[0], showroom: true })).toBe(false);
  });
});
