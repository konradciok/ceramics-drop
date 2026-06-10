import { describe, it, expect } from 'vitest';
import { PRICE_PLN, SHIPPING_PLN, toGrosze, orderAmountGrosze, shippingGrosze } from './pricing';

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
