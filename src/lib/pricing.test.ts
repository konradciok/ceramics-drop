import { describe, it, expect } from 'vitest';
import { PRICE_PLN, SHIPPING_PLN, toGrosze, orderAmountGrosze, shippingGrosze } from './pricing';

describe('pricing', () => {
  it('exposes PLN prices for all seven categories', () => {
    expect(PRICE_PLN.kubki).toBe(90);
    expect(PRICE_PLN['wazony-duze']).toBe(395);
  });

  it('exposes a per-method shipping price map', () => {
    expect(SHIPPING_PLN.kurier).toBe(75);
    expect(SHIPPING_PLN.paczkomat).toBe(15);
    expect(SHIPPING_PLN.odbior).toBe(0);
  });

  it('converts zloty to grosze', () => {
    expect(toGrosze(90)).toBe(9000);
    expect(toGrosze(0)).toBe(0);
  });

  it('computes shipping grosze per method', () => {
    expect(shippingGrosze('paczkomat')).toBe(1500);
    expect(shippingGrosze('kurier')).toBe(7500);
    expect(shippingGrosze('odbior')).toBe(0);
  });

  it('sums item grosze plus courier shipping', () => {
    const amount = orderAmountGrosze([9000, 21000], 'kurier');
    expect(amount).toBe(9000 + 21000 + 7500);
  });

  it('sums item grosze plus paczkomat shipping', () => {
    expect(orderAmountGrosze([9000], 'paczkomat')).toBe(9000 + 1500);
  });

  it('charges no shipping for pickup', () => {
    expect(orderAmountGrosze([9000], 'odbior')).toBe(9000);
  });
});
