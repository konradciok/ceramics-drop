import { describe, expect, it } from 'vitest';
import { registryProducts, VISIBLE_CATEGORY_ORDER } from '@/lib/products';
import { summariseCeramicShop } from './CeramicShopScreen';

const onSale = (ids: string[]) =>
  registryProducts().map((p) => ({ ...p, onlineAvailable: ids.includes(p.id), sold: !ids.includes(p.id) }));

const visibleCount = () =>
  registryProducts().filter((p) => VISIBLE_CATEGORY_ORDER.includes(p.category)).length;

describe('summariseCeramicShop', () => {
  it('lists only purchasable pieces, in family order', () => {
    const plate = registryProducts().find((p) => p.category === 'talerze-duze')!.id;
    // Given out of family order — the result follows VISIBLE_CATEGORY_ORDER.
    const { available } = summariseCeramicShop(onSale([plate, 'k01']));
    expect(available.map((p) => p.id)).toEqual(['k01', plate]);
  });

  it('summarises every visible family with its cover, total and on-sale count', () => {
    const products = onSale(['k01']);
    const { families } = summariseCeramicShop(products);
    expect(families.map((f) => f.slug)).toEqual(
      VISIBLE_CATEGORY_ORDER.filter((slug) => products.some((p) => p.category === slug)),
    );
    const kubki = families.find((f) => f.slug === 'kubki')!;
    expect(kubki.total).toBe(products.filter((p) => p.category === 'kubki').length);
    expect(kubki.available).toBe(1);
    expect(kubki.cover).toBe(products.find((p) => p.category === 'kubki')!.image);
  });

  it('returns no available pieces when everything is sold (the empty state)', () => {
    const { available, families } = summariseCeramicShop(onSale([]));
    expect(available).toEqual([]);
    expect(families.every((f) => f.available === 0)).toBe(true);
  });

  it('orders the gallery per family: on-sale pieces first, then sold ones', () => {
    const kubki = registryProducts().filter((p) => p.category === 'kubki').map((p) => p.id);
    const plate = registryProducts().find((p) => p.category === 'talerze-duze')!.id;
    const { pieces } = summariseCeramicShop(onSale([kubki[2], plate]));
    const ids = pieces.map((p) => p.id);
    // Every listed piece stays visible, sold ones included.
    expect(ids).toHaveLength(visibleCount());
    // kubki: the one on sale leads, the sold ones follow in their original order.
    expect(ids.slice(0, kubki.length)).toEqual([kubki[2], ...kubki.filter((id) => id !== kubki[2])]);
    // talerze-duze: its on-sale plate opens the family's block.
    const plates = pieces.filter((p) => p.category === 'talerze-duze');
    expect(plates[0].id).toBe(plate);
  });

  it('keeps every piece in the gallery when everything is sold', () => {
    const { pieces } = summariseCeramicShop(onSale([]));
    expect(pieces).toHaveLength(visibleCount());
  });
});
