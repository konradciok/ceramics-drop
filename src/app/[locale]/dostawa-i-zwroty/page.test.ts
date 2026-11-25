import { describe, it, expect } from 'vitest';
import { shippingCopyCurrency, shippingCopyValues } from '@/lib/shipping-copy';
import { CODE_SHIPPING_RATES } from '@/lib/shipping-rates/last-known-good';
import type { DomesticShippingRates, LockerShippingRates } from '@/lib/pricing';

describe('dostawa-i-zwroty copy matches checkout', () => {
  it('quotes both locker zones in the locale default currency: PLN in pl, EUR elsewhere', () => {
    expect(shippingCopyCurrency('pl')).toBe('pln');
    for (const locale of ['en', 'es', 'de']) expect(shippingCopyCurrency(locale)).toBe('eur');

    const { lockers, domestic } = CODE_SHIPPING_RATES;
    expect(shippingCopyValues('pl', CODE_SHIPPING_RATES)).toEqual({
      lockerEs: `${lockers.es.pln} zł`,
      lockerEu: `${lockers.eu.pln} zł`,
      courier: `${domestic.pln.kurier} zł`,
    });
    expect(shippingCopyValues('es', CODE_SHIPPING_RATES)).toEqual({
      lockerEs: `${lockers.es.eur} €`,
      lockerEu: `${lockers.eu.eur} €`,
      courier: `${domestic.eur.kurier} €`,
    });
  });

  it('follows the published tables, not the code constants', () => {
    const domestic: DomesticShippingRates = {
      pln: { paczkomat: 23, kurier: 37, odbior: 0 },
      eur: { paczkomat: 6, kurier: 11, odbior: 0 },
      gbp: { paczkomat: 5, kurier: 9, odbior: 0 },
    };
    const lockers = {
      es: { pln: 47, eur: 12, gbp: 11 },
      eu: { pln: 71, eur: 17, gbp: 15 },
    } as LockerShippingRates;
    expect(shippingCopyValues('pl', { domestic, lockers })).toEqual({ lockerEs: '47 zł', lockerEu: '71 zł', courier: '37 zł' });
    expect(shippingCopyValues('de', { domestic, lockers })).toEqual({ lockerEs: '12 €', lockerEu: '17 €', courier: '11 €' });
  });
});
