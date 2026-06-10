import { describe, it, expect } from 'vitest';
import { PRICE_PLN, SHIPPING_PLN, toGrosze, orderAmountGrosze, shippingGrosze } from './pricing';
import { PRICE_EUR, SHIPPING_EUR, toEuroCents, shippingEuroCents, orderAmountEuroCents } from './pricing';
import type { CategorySlug } from './types';

describe('pricing', () => {
  it('exposes PLN prices for all nine categories', () => {
    expect(PRICE_PLN).toEqual({
      kubki: 90,
      wazony: 210,
      'wazony-srednie': 300,
      'wazony-duze': 395,
      talerzyki: 105,
      'talerze-srednie': 120,
      'talerze-duze': 270,
      'duze-michy': 315,
      'miski-falowane': 155,
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
