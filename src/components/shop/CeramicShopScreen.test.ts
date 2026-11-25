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

  it('lists every piece that cannot be bought now separately, in family order', () => {
    const kubki = registryProducts().filter((p) => p.category === 'kubki').map((p) => p.id);
    const plate = registryProducts().find((p) => p.category === 'talerze-duze')!.id;
    // A reserved mug: neither sold nor purchasable (checkout holds it for 15 min).
    const products = onSale([kubki[0], kubki[2]]).map((p) =>
      p.id === kubki[2] ? { ...p, onlineAvailable: false, saleState: 'reserved' as const } : p,
    );
    const { available, unavailable } = summariseCeramicShop(products);
    expect(available.map((p) => p.id)).toEqual([kubki[0]]);
    const ids = unavailable.map((p) => p.id);
    // Everything listed is still on the page, exactly once.
    expect(ids).toHaveLength(visibleCount() - 1);
    expect(ids).not.toContain(kubki[0]);
    // kubki first (family order), the reserved mug in its original position;
    // the plate (sold) is listed in its own family's block.
    expect(ids.slice(0, kubki.length - 1)).toEqual(kubki.filter((id) => id !== kubki[0]));
    expect(ids).toContain(plate);
  });

  it('keeps every piece on the page when everything is sold', () => {
    const { available, unavailable } = summariseCeramicShop(onSale([]));
    expect(available).toEqual([]);
    expect(unavailable).toHaveLength(visibleCount());
  });
});
