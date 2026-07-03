import { describe, it, expect } from 'vitest';
import { PRINT_COUNTRIES, isPrintCountry, printShippingOf } from './print-shipping';

describe('PRINT_COUNTRIES', () => {
  it('covers the 27 EU members + GB', () => {
    expect(PRINT_COUNTRIES).toHaveLength(28);
    expect(isPrintCountry('PL')).toBe(true);
    expect(isPrintCountry('GB')).toBe(true);
    expect(isPrintCountry('US')).toBe(false);
    expect(isPrintCountry('CH')).toBe(false);
  });
});

describe('printShippingOf', () => {
  it('charges the framed Prodigi rate, rounded up (PL framed: €18.35)', () => {
    expect(printShippingOf('PL', true, 'eur')).toBe(19);
    expect(printShippingOf('PL', true, 'pln')).toBe(Math.ceil(18.35 * 4.25));
    expect(printShippingOf('PL', true, 'gbp')).toBe(Math.ceil(18.35 * 0.86));
  });
  it('charges the cheaper loose rate for unframed-only carts (GB loose: €5.66)', () => {
    expect(printShippingOf('GB', false, 'eur')).toBe(6);
    expect(printShippingOf('GB', true, 'eur')).toBe(21);
  });
});
