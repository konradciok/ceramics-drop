import { describe, expect, it } from 'vitest';
import { registryProducts, VISIBLE_CATEGORY_ORDER } from '@/lib/products';
import { summariseCeramicShop } from './CeramicShopScreen';

const onSale = (ids: string[]) =>
  registryProducts().map((p) => ({ ...p, onlineAvailable: ids.includes(p.id), sold: !ids.includes(p.id) }));

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
});
