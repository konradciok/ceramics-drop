import { describe, expect, it } from 'vitest';
import { deliveryRatesFor } from './delivery-rates';
import { CHECKOUT_DESTINATION, DESTINATIONS } from '@/lib/delivery/destinations';
import type { DomesticShippingRates, LockerShippingRates } from '@/lib/pricing';

const DOMESTIC: DomesticShippingRates = {
  pln: { paczkomat: 24, kurier: 44, odbior: 0 },
  eur: { paczkomat: 6, kurier: 11, odbior: 0 },
  gbp: { paczkomat: 6, kurier: 13, odbior: 0 },
};
const LOCKERS: LockerShippingRates = {
  es: { pln: 47, eur: 12, gbp: 11 },
  eu: { pln: 71, eur: 17, gbp: 15 },
};

describe('deliveryRatesFor', () => {
  it("prices Poland's locker from the 'eu' zone and keeps courier/pickup from the domestic table", () => {
    expect(DESTINATIONS.PL.zone).toBe('eu');
    expect(deliveryRatesFor({ domestic: DOMESTIC, lockers: LOCKERS }, 'PL')).toEqual({
      pln: { paczkomat: 71, kurier: 44, odbior: 0 },
      eur: { paczkomat: 17, kurier: 11, odbior: 0 },
      gbp: { paczkomat: 15, kurier: 13, odbior: 0 },
    });
  });

  it("prices Spain's locker from the 'es' zone", () => {
    const rates = deliveryRatesFor({ domestic: DOMESTIC, lockers: LOCKERS }, 'ES');
    expect(rates.pln.paczkomat).toBe(47);
    expect(rates.eur.paczkomat).toBe(12);
    expect(rates.gbp.paczkomat).toBe(11);
  });

  it('defaults to the checkout destination', () => {
    expect(deliveryRatesFor({ domestic: DOMESTIC, lockers: LOCKERS })).toEqual(
      deliveryRatesFor({ domestic: DOMESTIC, lockers: LOCKERS }, CHECKOUT_DESTINATION.country),
    );
  });

  it('every destination outside Spain is in the eu zone', () => {
    for (const [country, destination] of Object.entries(DESTINATIONS)) {
      expect(destination.zone).toBe(country === 'ES' ? 'es' : 'eu');
    }
  });

  it('never mutates the tables it reads', () => {
    const domestic = structuredClone(DOMESTIC);
    const lockers = structuredClone(LOCKERS);
    deliveryRatesFor({ domestic, lockers }, 'ES');
    expect(domestic).toEqual(DOMESTIC);
    expect(lockers).toEqual(LOCKERS);
  });
});
