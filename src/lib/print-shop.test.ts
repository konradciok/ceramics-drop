import { describe, expect, it } from 'vitest';
import {
  applyShopView,
  buildShopRanks,
  DEFAULT_SHOP_VIEW,
  hasActiveFilters,
  interleaveByCollection,
  newestIds,
  parseShopView,
  serializeShopView,
  type ShopFilterable,
  type ShopView,
} from './print-shop';

const groups = [
  { slug: 'a', designs: [{ id: 'fap001' }, { id: 'fap002' }, { id: 'fap003' }] },
  { slug: 'b', designs: [{ id: 'fap010' }, { id: 'fap011' }] },
  { slug: 'c', designs: [{ id: 'fap050' }] },
];

describe('parseShopView', () => {
  it('defaults when nothing is supplied', () => {
    expect(parseShopView({})).toEqual(DEFAULT_SHOP_VIEW);
    expect(parseShopView(new URLSearchParams())).toEqual(DEFAULT_SHOP_VIEW);
  });

  it('reads Next searchParams records and URLSearchParams alike', () => {
    const expected: ShopView = { sort: 'new', colours: ['blue', 'green'], collection: 'linea' };
    expect(parseShopView({ sort: 'new', kolor: 'blue,green', kolekcja: 'linea' })).toEqual(expected);
    expect(parseShopView(new URLSearchParams('sort=new&kolor=blue,green&kolekcja=linea'))).toEqual(expected);
  });

  it('takes the first value of a repeated key', () => {
    expect(parseShopView({ sort: ['new', 'collection'] }).sort).toBe('new');
  });

  it('ignores unknown sorts and colours and de-duplicates', () => {
    const view = parseShopView({ sort: 'price', kolor: 'blue,neon,blue, green ' });
    expect(view.sort).toBe('featured');
    expect(view.colours).toEqual(['blue', 'green']);
  });

  it('drops a collection that is not known when a list is supplied', () => {
    expect(parseShopView({ kolekcja: 'nope' }, ['linea']).collection).toBeUndefined();
    expect(parseShopView({ kolekcja: 'linea' }, ['linea']).collection).toBe('linea');
    expect(parseShopView({ kolekcja: 'anything' }).collection).toBe('anything');
  });
});

describe('serializeShopView', () => {
  it('omits defaults so the plain shop URL stays clean', () => {
    expect(serializeShopView(DEFAULT_SHOP_VIEW)).toBe('');
  });

  it('round-trips through parseShopView with a readable comma', () => {
    const view: ShopView = { sort: 'collection', colours: ['green', 'blue'], collection: 'linea' };
    const qs = serializeShopView(view);
    expect(qs).toBe('sort=collection&kolor=blue,green&kolekcja=linea');
    expect(parseShopView(new URLSearchParams(qs))).toEqual({ sort: 'collection', colours: ['blue', 'green'], collection: 'linea' });
  });
});

describe('hasActiveFilters', () => {
  it('is false for a sort-only view and true when narrowing', () => {
    expect(hasActiveFilters({ sort: 'new', colours: [] })).toBe(false);
    expect(hasActiveFilters({ sort: 'featured', colours: ['blue'] })).toBe(true);
    expect(hasActiveFilters({ sort: 'featured', colours: [], collection: 'a' })).toBe(true);
  });
});

describe('interleaveByCollection', () => {
  it('round-robins across collections', () => {
    expect(interleaveByCollection(groups.map((g) => ({ designs: g.designs.map((d) => d.id) })))).toEqual([
      'fap001', 'fap010', 'fap050', 'fap002', 'fap011', 'fap003',
    ]);
  });

  it('handles empty input', () => {
    expect(interleaveByCollection([])).toEqual([]);
  });
});

describe('newestIds', () => {
  it('returns the highest-numbered ids', () => {
    expect(newestIds(['fap001', 'fap050', 'fap011', 'fap003'], 2)).toEqual(new Set(['fap050', 'fap011']));
    expect(newestIds(['fap001'], 0)).toEqual(new Set());
  });
});

describe('buildShopRanks', () => {
  const ranks = buildShopRanks(groups, ['fap011', 'ghost']);
  const order = (key: 'featured' | 'new' | 'collection') =>
    [...ranks.entries()].sort((a, b) => a[1][key] - b[1][key]).map(([id]) => id);

  it('collection order is curated group order', () => {
    expect(order('collection')).toEqual(['fap001', 'fap002', 'fap003', 'fap010', 'fap011', 'fap050']);
  });

  it('new order is highest id first', () => {
    expect(order('new')).toEqual(['fap050', 'fap011', 'fap010', 'fap003', 'fap002', 'fap001']);
  });

  it('featured order pins configured ids (ignoring unknown) then interleaves the rest', () => {
    expect(order('featured')).toEqual(['fap011', 'fap001', 'fap010', 'fap050', 'fap002', 'fap003']);
  });

  it('assigns a distinct rank per design under every sort', () => {
    for (const key of ['featured', 'new', 'collection'] as const) {
      expect(new Set([...ranks.values()].map((r) => r[key])).size).toBe(ranks.size);
    }
  });
});

describe('applyShopView', () => {
  const ranks = buildShopRanks(groups);
  type Item = ShopFilterable & { id: string };
  const base: Omit<Item, 'rank'>[] = [
    { id: 'fap001', collectionSlug: 'a', colours: ['blue'] },
    { id: 'fap002', collectionSlug: 'a', colours: ['green', 'earth'] },
    { id: 'fap003', collectionSlug: 'a', colours: ['mono'] },
    { id: 'fap010', collectionSlug: 'b', colours: ['blue', 'warm'] },
    { id: 'fap011', collectionSlug: 'b', colours: [] },
    { id: 'fap050', collectionSlug: undefined, colours: ['pink'] },
  ];
  const items: Item[] = base.map((i) => ({ ...i, rank: ranks.get(i.id)! }));
  const ids = (view: ShopView) => applyShopView(items, view).map((i) => i.id);

  it('returns everything for the default view, in featured order', () => {
    expect(ids(DEFAULT_SHOP_VIEW)).toEqual(['fap001', 'fap010', 'fap050', 'fap002', 'fap011', 'fap003']);
  });

  it('colour filter matches ANY selected family (OR)', () => {
    expect(ids({ sort: 'collection', colours: ['blue'] })).toEqual(['fap001', 'fap010']);
    expect(ids({ sort: 'collection', colours: ['blue', 'green'] })).toEqual(['fap001', 'fap002', 'fap010']);
  });

  it('collection and colour combine with AND', () => {
    expect(ids({ sort: 'collection', colours: ['blue'], collection: 'b' })).toEqual(['fap010']);
  });

  it('a design with no colour data never matches a colour filter but still shows unfiltered', () => {
    expect(ids({ sort: 'collection', colours: ['mono', 'blue', 'green', 'warm', 'pink', 'earth'] })).not.toContain('fap011');
    expect(ids({ sort: 'collection', colours: [] })).toContain('fap011');
  });

  it('sorts newest first', () => {
    expect(ids({ sort: 'new', colours: [] })[0]).toBe('fap050');
  });

  it('does not mutate the input', () => {
    const before = items.map((i) => i.id);
    applyShopView(items, { sort: 'new', colours: [] });
    expect(items.map((i) => i.id)).toEqual(before);
  });

  it('returns an empty list when nothing matches', () => {
    expect(ids({ sort: 'featured', colours: [], collection: 'zzz' })).toEqual([]);
  });
});
