import { describe, expect, it } from 'vitest';
import { registryProducts } from '@/lib/products';
import type { Product } from '@/lib/types';
import { pickPdpSiblings, PDP_SIBLINGS_MAX, SOLD_PDP_SIBLINGS_MAX } from './pdp-siblings';

const kubki = registryProducts().filter((p) => p.category === 'kubki');

/** The kubki family with `onSale` ids purchasable and every other piece sold. */
const family = (onSale: string[]): Product[] =>
  kubki.map((p) => ({ ...p, onlineAvailable: true, sold: !onSale.includes(p.id) }));

const ids = (products: Product[]) => products.map((p) => p.id);

describe('pickPdpSiblings', () => {
  it('puts purchasable pieces first on an available PDP, even when they sit late in the family', () => {
    const [current, ...rest] = kubki.map((p) => p.id);
    const late = rest.slice(-2);
    const pieces = family([current, ...late]);
    const picked = pickPdpSiblings(pieces[0], pieces);
    expect(ids(picked).slice(0, 2)).toEqual(late);
    expect(picked).toHaveLength(PDP_SIBLINGS_MAX);
    expect(picked.slice(2).every((p) => p.sold)).toBe(true);
  });

  it('fills with sold pieces only when fewer than four are purchasable', () => {
    const onSale = kubki.slice(0, 6).map((p) => p.id);
    const pieces = family(onSale);
    const picked = pickPdpSiblings(pieces[0], pieces);
    expect(ids(picked)).toEqual(onSale.slice(1, 5));
    expect(picked.some((p) => p.sold)).toBe(false);
  });

  it('fills with sold and showroom pieces but never an unbadged reserved or offline one', () => {
    const pieces = family([kubki[0].id]);
    // Unsold but not purchasable: a live checkout hold sets onlineAvailable false.
    pieces[1] = { ...pieces[1], sold: false, onlineAvailable: false };
    pieces[2] = { ...pieces[2], sold: false, showroom: true };
    const picked = pickPdpSiblings(pieces[0], pieces);
    expect(ids(picked)).not.toContain(pieces[1].id);
    expect(ids(picked)).toEqual([pieces[2].id, pieces[3].id, pieces[4].id, pieces[5].id]);
    expect(picked.every((p) => p.sold || p.showroom)).toBe(true);
  });

  it('never recommends the current piece', () => {
    const pieces = family(kubki.map((p) => p.id));
    for (const current of pieces.slice(0, 5)) {
      expect(ids(pickPdpSiblings(current, pieces))).not.toContain(current.id);
    }
  });

  it('shows only purchasable pieces (at most three) on a sold PDP', () => {
    const onSale = kubki.slice(-5).map((p) => p.id);
    const pieces = family(onSale);
    const sold = pieces[0];
    expect(sold.sold).toBe(true);
    const picked = pickPdpSiblings(sold, pieces);
    expect(ids(picked)).toEqual(onSale.slice(0, SOLD_PDP_SIBLINGS_MAX));
    expect(picked.every((p) => !p.sold)).toBe(true);
  });

  it('skips showroom and offline pieces on a sold PDP', () => {
    const pieces = family(kubki.slice(1, 4).map((p) => p.id));
    pieces[1] = { ...pieces[1], showroom: true };
    pieces[2] = { ...pieces[2], onlineAvailable: false };
    expect(ids(pickPdpSiblings(pieces[0], pieces))).toEqual([pieces[3].id]);
  });

  it('returns nothing on a sold PDP when the family has nothing left to buy', () => {
    const pieces = family([]);
    expect(pickPdpSiblings(pieces[0], pieces)).toEqual([]);
  });
});
