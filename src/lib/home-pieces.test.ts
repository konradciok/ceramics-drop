import { describe, expect, it } from 'vitest';
import { registryProducts } from '@/lib/products';
import { summariseCeramicShop } from '@/components/shop/CeramicShopScreen';
import { HOME_PIECES_MAX, pickHomePieces } from './home-pieces';

const inFamily = (slug: string) => registryProducts().filter((p) => p.category === slug);

const onSale = (ids: string[]) =>
  registryProducts().map((p) => ({ ...p, onlineAvailable: ids.includes(p.id), sold: !ids.includes(p.id) }));

describe('pickHomePieces', () => {
  it('takes one piece per family in turn, keeping family and catalogue order', () => {
    const mugs = inFamily('kubki').slice(0, 3).map((p) => p.id);
    const plate = inFamily('talerze-duze')[0].id;
    const { available } = summariseCeramicShop(onSale([...mugs, plate]));
    expect(pickHomePieces(available).map((p) => p.id)).toEqual([mugs[0], plate, mugs[1], mugs[2]]);
  });

  it(`caps the row at ${HOME_PIECES_MAX} and spreads it across families`, () => {
    // Everything on sale: the first round alone visits every family.
    const all = registryProducts().map((p) => p.id);
    const { available, families } = summariseCeramicShop(onSale(all));
    const picked = pickHomePieces(available);
    expect(picked).toHaveLength(HOME_PIECES_MAX);
    expect(new Set(picked.map((p) => p.category)).size).toBe(Math.min(HOME_PIECES_MAX, families.length));
  });

  it('never picks a piece that is not in the purchasable list', () => {
    const mug = inFamily('kubki')[0].id;
    const { available } = summariseCeramicShop(onSale([mug]));
    expect(pickHomePieces(available).map((p) => p.id)).toEqual([mug]);
  });

  it('returns nothing when nothing is on sale', () => {
    expect(pickHomePieces([])).toEqual([]);
  });
});
