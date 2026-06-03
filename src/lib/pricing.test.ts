import { describe, it, expect } from 'vitest';
import { PRICE_PLN, SHIPPING_PLN, toGrosze, orderAmountGrosze } from './pricing';

describe('pricing', () => {
  it('exposes PLN prices for all seven categories', () => {
    expect(PRICE_PLN.kubki).toBe(90);
    expect(PRICE_PLN['wazony-duze']).toBe(395);
    expect(SHIPPING_PLN).toBe(75);
  });

  it('converts zloty to grosze', () => {
    expect(toGrosze(90)).toBe(9000);
    expect(toGrosze(0)).toBe(0);
  });

  it('sums item grosze plus courier shipping', () => {
    const amount = orderAmountGrosze([9000, 21000], 'kurier');
    expect(amount).toBe(9000 + 21000 + 7500);
  });

  it('charges no shipping for pickup', () => {
    expect(orderAmountGrosze([9000], 'odbior')).toBe(9000);
  });
});
