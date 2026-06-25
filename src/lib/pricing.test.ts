import { describe, it, expect } from 'vitest';
import { PRICE_PLN, SHIPPING_PLN, toGrosze, orderAmountGrosze, shippingGrosze, priceOf } from './pricing';
import { PRICE_EUR, SHIPPING_EUR, toEuroCents, shippingEuroCents, orderAmountEuroCents } from './pricing';
import { PRICE_GBP, SHIPPING_GBP, toGBPPence, shippingGBPPence, orderAmountGBPPence } from './pricing';
import type { CategorySlug } from './types';

describe('pricing', () => {
  it('exposes PLN prices for every category (nine ceramics + prints "from")', () => {
    expect(PRICE_PLN).toEqual({
      kubki: 95,
      wazony: 239,
      'wazony-srednie': 289,
      'wazony-duze': 379,
      talerzyki: 69,
      'talerze-srednie': 119,
      'talerze-duze': 160,
      'duze-michy': 345,
      'miski-falowane': 195,
      'fine-art-prints': 120,
    });
  });

  it('exposes a per-method shipping price map', () => {
    expect(SHIPPING_PLN.kurier).toBe(30);
    expect(SHIPPING_PLN.paczkomat).toBe(20);
    expect(SHIPPING_PLN.odbior).toBe(0);
  });

  it('converts zloty to grosze', () => {
    expect(toGrosze(90)).toBe(9000);
    expect(toGrosze(0)).toBe(0);
  });

  it('computes shipping grosze per method', () => {
    expect(shippingGrosze('paczkomat')).toBe(2000);
    expect(shippingGrosze('kurier')).toBe(3000);
    expect(shippingGrosze('odbior')).toBe(0);
  });

  it('sums item grosze plus courier shipping', () => {
    const amount = orderAmountGrosze([9000, 21000], 'kurier');
    expect(amount).toBe(9000 + 21000 + 3000);
  });

  it('sums item grosze plus paczkomat shipping', () => {
    expect(orderAmountGrosze([9000], 'paczkomat')).toBe(9000 + 2000);
  });

  it('charges no shipping for pickup', () => {
    expect(orderAmountGrosze([9000], 'odbior')).toBe(9000);
  });
});

describe('priceOf', () => {
  const ALL_CATEGORIES: CategorySlug[] = [
    'kubki', 'wazony', 'wazony-srednie', 'wazony-duze', 'talerzyki',
    'talerze-srednie', 'talerze-duze', 'duze-michy', 'miski-falowane',
  ];

  it('returns PLN price for pl locale', () => {
    expect(priceOf({ category: 'kubki', price: PRICE_PLN.kubki }, 'pl')).toBe(PRICE_PLN.kubki);
  });

  it('returns EUR price for en locale', () => {
    expect(priceOf({ category: 'kubki', price: PRICE_PLN.kubki }, 'en')).toBe(PRICE_EUR.kubki);
  });

  it('returns EUR price for es locale', () => {
    expect(priceOf({ category: 'kubki', price: PRICE_PLN.kubki }, 'es')).toBe(PRICE_EUR.kubki);
  });

  it('resolves all nine categories correctly for pl and en', () => {
    for (const cat of ALL_CATEGORIES) {
      expect(priceOf({ category: cat, price: PRICE_PLN[cat] }, 'pl')).toBe(PRICE_PLN[cat]);
      expect(priceOf({ category: cat, price: PRICE_PLN[cat] }, 'en')).toBe(PRICE_EUR[cat]);
    }
  });
});

describe('EUR pricing helpers', () => {
  const ALL_CATEGORIES: CategorySlug[] = [
    'kubki', 'wazony', 'wazony-srednie', 'wazony-duze', 'talerzyki',
    'talerze-srednie', 'talerze-duze', 'duze-michy', 'miski-falowane',
  ];

  it('PRICE_EUR covers every category with a positive value', () => {
    for (const cat of ALL_CATEGORIES) {
      expect(PRICE_EUR[cat]).toBeGreaterThan(0);
    }
  });

  it('toEuroCents multiplies by 100', () => {
    expect(toEuroCents(22)).toBe(2200);
    expect(toEuroCents(0)).toBe(0);
  });

  it('shippingEuroCents returns zero for odbior', () => {
    expect(shippingEuroCents('odbior')).toBe(0);
  });

  it('orderAmountEuroCents sums items + paczkomat shipping', () => {
    // kubki=22€, wazony=50€, paczkomat=5€ → (2200+5000)+500 = 7700
    expect(orderAmountEuroCents([2200, 5000], 'paczkomat')).toBe(7700);
  });

  it('SHIPPING_EUR has expected values for all methods', () => {
    expect(SHIPPING_EUR.paczkomat).toBe(5);
    expect(SHIPPING_EUR.kurier).toBe(10);
    expect(SHIPPING_EUR.odbior).toBe(0);
  });

  it('shippingEuroCents returns correct cents for all methods', () => {
    expect(shippingEuroCents('paczkomat')).toBe(500);
    expect(shippingEuroCents('kurier')).toBe(1000);
    expect(shippingEuroCents('odbior')).toBe(0);
  });

  it('orderAmountEuroCents handles kurier shipping', () => {
    expect(orderAmountEuroCents([2200], 'kurier')).toBe(3200); // 2200 + 1000
  });

  it('orderAmountEuroCents handles odbior (free)', () => {
    expect(orderAmountEuroCents([5000], 'odbior')).toBe(5000); // 5000 + 0
  });
});

describe('GBP pricing helpers', () => {
  const ALL_CATEGORIES: CategorySlug[] = [
    'kubki', 'wazony', 'wazony-srednie', 'wazony-duze', 'talerzyki',
    'talerze-srednie', 'talerze-duze', 'duze-michy', 'miski-falowane',
  ];

  it('PRICE_GBP covers every category with a positive value', () => {
    for (const cat of ALL_CATEGORIES) {
      expect(PRICE_GBP[cat]).toBeGreaterThan(0);
    }
  });

  it('toGBPPence multiplies by 100', () => {
    expect(toGBPPence(22)).toBe(2200);
    expect(toGBPPence(0)).toBe(0);
  });

  it('SHIPPING_GBP has expected values for all methods', () => {
    expect(SHIPPING_GBP.paczkomat).toBe(5);
    expect(SHIPPING_GBP.kurier).toBe(12);
    expect(SHIPPING_GBP.odbior).toBe(0);
  });

  it('shippingGBPPence returns correct pence for all methods', () => {
    expect(shippingGBPPence('paczkomat')).toBe(500);
    expect(shippingGBPPence('kurier')).toBe(1200);
    expect(shippingGBPPence('odbior')).toBe(0);
  });

  it('orderAmountGBPPence sums items + paczkomat shipping', () => {
    expect(orderAmountGBPPence([2200, 5500], 'paczkomat')).toBe(2200 + 5500 + 500);
  });

  it('orderAmountGBPPence handles kurier shipping', () => {
    expect(orderAmountGBPPence([2200], 'kurier')).toBe(3400); // 2200 + 1200
  });

  it('orderAmountGBPPence handles odbior (free)', () => {
    expect(orderAmountGBPPence([5000], 'odbior')).toBe(5000);
  });
});
