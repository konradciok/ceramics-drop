import { describe, it, expect } from 'vitest';
import { shippingCopyCurrency, shippingCopyValues } from '@/lib/shipping-copy';
import { CODE_SHIPPING_RATES } from '@/lib/shipping-rates/last-known-good';
import type { DomesticShippingRates } from '@/lib/pricing';

describe('dostawa-i-zwroty copy matches checkout', () => {
  it('quotes the code-default InPost prices exactly as the former hard-coded copy did', () => {
    const d = CODE_SHIPPING_RATES.domestic;
    // pl/en/es kept "zł", de kept "€" — wording must not change with placeholders.
    for (const locale of ['pl', 'en', 'es']) {
      expect(shippingCopyCurrency(locale)).toBe('pln');
      expect(shippingCopyValues(locale, d)).toEqual({ locker: '20 zł', courier: '30 zł' });
    }
    expect(shippingCopyCurrency('de')).toBe('eur');
    expect(shippingCopyValues('de', d)).toEqual({ locker: '5 €', courier: '10 €' });
  });

  it('follows the published table, not the code constants', () => {
    const published: DomesticShippingRates = {
      pln: { paczkomat: 23, kurier: 37, odbior: 0 },
      eur: { paczkomat: 6, kurier: 11, odbior: 0 },
      gbp: { paczkomat: 5, kurier: 9, odbior: 0 },
    };
    expect(shippingCopyValues('pl', published)).toEqual({ locker: '23 zł', courier: '37 zł' });
    expect(shippingCopyValues('de', published)).toEqual({ locker: '6 €', courier: '11 €' });
  });
});
