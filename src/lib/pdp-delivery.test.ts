import { describe, it, expect } from 'vitest';
import { pdpDeliveryQuote } from './pdp-delivery';
import { CODE_SHIPPING_RATES, type ShippingRatesBundle } from './shipping-rates/last-known-good';
import type { LockerShippingRates } from './pricing';

// A published table that differs from the code defaults, so a quote read from
// the constants instead would fail.
const SHIPPING: ShippingRatesBundle = {
  ...CODE_SHIPPING_RATES,
  lockers: { es: { pln: 47, eur: 12, gbp: 11 }, eu: { pln: 71, eur: 17, gbp: 15 } } as LockerShippingRates,
};
const COUNTRIES = ['ES', 'PT', 'DE', 'PL'] as const;
const OFF = { courierEnabled: false, pickupEnabled: false };

describe('pdpDeliveryQuote', () => {
  it("names the visitor's country with its published locker price when the country is known", () => {
    const q = pdpDeliveryQuote({ item: 95, currency: 'pln', shipping: SHIPPING, countries: COUNTRIES, visitor: { country: 'PL', known: true }, ...OFF });
    expect(q.rows).toEqual([{ kind: 'locker-country', country: 'PL', price: 71 }]);
    expect(q.total).toBe(95 + 71);
    expect(q.exact).toBe(true);
    expect(q.transitDays).toBe(7);

    const es = pdpDeliveryQuote({ item: 25, currency: 'eur', shipping: SHIPPING, countries: COUNTRIES, visitor: { country: 'ES', known: true }, ...OFF });
    expect(es.rows).toEqual([{ kind: 'locker-country', country: 'ES', price: 12 }]);
    expect(es.total).toBe(37);
    expect(es.transitDays).toBe(4);
  });

  it('lists every zone, cheapest-first as checkout orders them, when the country is a guess', () => {
    const q = pdpDeliveryQuote({ item: 22, currency: 'gbp', shipping: SHIPPING, countries: COUNTRIES, visitor: { country: 'ES', known: false }, ...OFF });
    expect(q.rows).toEqual([
      { kind: 'locker-zone', zone: 'es', multiZone: true, price: 11 },
      { kind: 'locker-zone', zone: 'eu', multiZone: true, price: 15 },
    ]);
    expect(q.total).toBe(22 + 11);
    expect(q.exact).toBe(false);
    expect(q.transitDays).toBeNull();
  });

  it('keeps one plain locker row when checkout offers a single zone', () => {
    const q = pdpDeliveryQuote({ item: 95, currency: 'pln', shipping: SHIPPING, countries: ['PL', 'DE'], visitor: { country: 'PL', known: false }, ...OFF });
    expect(q.rows).toEqual([{ kind: 'locker-zone', zone: 'eu', multiZone: false, price: 71 }]);
  });

  it('is only an estimate while courier or studio pickup are on offer', () => {
    const q = pdpDeliveryQuote({ item: 95, currency: 'pln', shipping: SHIPPING, countries: COUNTRIES, visitor: { country: 'PL', known: true }, courierEnabled: true, pickupEnabled: true });
    expect(q.rows.map((r) => r.kind)).toEqual(['pickup', 'locker-country', 'courier']);
    expect(q.exact).toBe(false);
  });
});
