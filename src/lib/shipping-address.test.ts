import { describe, expect, it } from 'vitest';
import { formatShippingAddress, normalizeShippingAddress } from './shipping-address';

describe('shipping address compatibility', () => {
  it('reads native print line1 and optional line2 without loss', () => {
    const raw = { line1: '221B Baker Street', line2: 'Flat B', city: 'London', post_code: 'NW1', country_code: 'GB' };
    expect(normalizeShippingAddress(raw)).toEqual(raw);
    expect(formatShippingAddress(raw)).toBe('221B Baker Street, Flat B, NW1 London, GB');
  });

  it('combines the legacy ceramic street and building number', () => {
    const raw = { street: 'Floriańska', building_number: '12', city: 'Kraków', post_code: '31-019', country_code: 'PL' };
    expect(normalizeShippingAddress(raw)).toEqual({
      line1: 'Floriańska 12',
      city: 'Kraków',
      post_code: '31-019',
      country_code: 'PL',
      street: 'Floriańska',
      building_number: '12',
    });
  });

  it('fails closed for incomplete or unknown data', () => {
    expect(normalizeShippingAddress(null)).toBeNull();
    expect(normalizeShippingAddress({ line1: 'X', city: 'Y' })).toBeNull();
  });
});
