import { afterEach, describe, expect, it } from 'vitest';
import {
  CODE_SHIPPING_RATES,
  recordShippingRatesSuccess,
  resetLastKnownGoodForTests,
  resolveShippingRatesFallback,
} from './last-known-good';
import { DEFAULT_DOMESTIC_SHIPPING } from '../pricing';
import { DEFAULT_INTERNATIONAL_SHIPPING } from '../print-shipping';

const DB_RATES = {
  domestic: {
    pln: { paczkomat: 22, kurier: 33, odbior: 0 },
    eur: { paczkomat: 6, kurier: 11, odbior: 0 },
    gbp: { paczkomat: 6, kurier: 13, odbior: 0 },
  },
  international: { ...DEFAULT_INTERNATIONAL_SHIPPING, PL: { framed: 19.99, loose: 11.11 } },
};

afterEach(() => resetLastKnownGoodForTests());

describe('CODE_SHIPPING_RATES', () => {
  it('is exactly the two shipped constant tables — the outage/code-mode floor', () => {
    expect(CODE_SHIPPING_RATES.domestic).toBe(DEFAULT_DOMESTIC_SHIPPING);
    expect(CODE_SHIPPING_RATES.international).toBe(DEFAULT_INTERNATIONAL_SHIPPING);
  });
});

describe('resolveShippingRatesFallback', () => {
  it('on a cold isolate falls back to the code constants — never fails checkout closed', () => {
    // Deliberately unlike print-pricing-config/last-known-good.ts's
    // cold-fail-closed: shipping has ALWAYS been served from these constants on
    // every checkout, so failing closed here would make checkout strictly less
    // available than it was before the cutover. See the module header.
    const fallback = resolveShippingRatesFallback();
    expect(fallback.tier).toBe('code-default');
    expect(fallback.rates).toBe(CODE_SHIPPING_RATES);
  });

  it('after a successful read, prefers that real observed value over the constants', () => {
    recordShippingRatesSuccess(DB_RATES);
    const fallback = resolveShippingRatesFallback();
    expect(fallback.tier).toBe('last-known-good');
    expect(fallback.rates).toEqual(DB_RATES);
  });

  it('keeps the most recent success', () => {
    recordShippingRatesSuccess(DB_RATES);
    const newer = { ...DB_RATES, domestic: { ...DB_RATES.domestic, pln: { paczkomat: 25, kurier: 35, odbior: 0 } } };
    recordShippingRatesSuccess(newer);
    expect(resolveShippingRatesFallback().rates).toEqual(newer);
  });

  it('resetLastKnownGoodForTests clears the isolate state', () => {
    recordShippingRatesSuccess(DB_RATES);
    resetLastKnownGoodForTests();
    expect(resolveShippingRatesFallback().tier).toBe('code-default');
  });
});
