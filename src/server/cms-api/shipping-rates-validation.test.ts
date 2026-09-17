import { describe, expect, it } from 'vitest';
import { parseShippingRateFields, validateShippingRatesSave } from './shipping-rates-validation';
import { buildShippingRateFields } from './shipping-rates-mapping';
import { DEFAULT_DOMESTIC_SHIPPING } from '@/lib/pricing';
import { DEFAULT_INTERNATIONAL_SHIPPING } from '@/lib/print-shipping';
import type { Field } from './types';

const RATES = { domestic: DEFAULT_DOMESTIC_SHIPPING, international: DEFAULT_INTERNATIONAL_SHIPPING };

const domesticFields = () => buildShippingRateFields('domestic', RATES);
const internationalFields = () => buildShippingRateFields('international', RATES);

function withValue(fields: Field[], key: string, value: string): Field[] {
  return fields.map((f) => (f.key === key ? { ...f, value } : f));
}

function numberField(key: string, value: string): Field {
  return { key, label: key, type: 'number', value, locale: 'none', sourceLocale: 'none' };
}

describe('validateShippingRatesSave', () => {
  it('accepts a well-formed ResourceSave envelope', () => {
    const result = validateShippingRatesSave({ expectedRevision: 1, name: 'Dostawa krajowa (InPost)', fields: domesticFields() });
    expect(result.ok).toBe(true);
  });

  it('rejects a missing expectedRevision with a keyed field error', () => {
    const result = validateShippingRatesSave({ name: 'x', fields: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors).toHaveProperty('expectedRevision');
  });

  it('rejects a blank name', () => {
    const result = validateShippingRatesSave({ expectedRevision: 1, name: '   ', fields: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors).toHaveProperty('name');
  });

  it('rejects unknown top-level keys (strict envelope)', () => {
    const result = validateShippingRatesSave({ expectedRevision: 1, name: 'x', fields: [], draft: {} });
    expect(result.ok).toBe(false);
  });

  it('rejects a field with an unknown type', () => {
    const result = validateShippingRatesSave({
      expectedRevision: 1,
      name: 'x',
      fields: [{ ...numberField('kurier_pln', '30'), type: 'money' }],
    });
    expect(result.ok).toBe(false);
  });

  it('does NOT range-check: a draft may hold out-of-range values mid-edit', () => {
    const result = validateShippingRatesSave({
      expectedRevision: 1,
      name: 'x',
      fields: withValue(domesticFields(), 'kurier_pln', '-5'),
    });
    expect(result.ok).toBe(true);
  });
});

describe('parseShippingRateFields — domestic', () => {
  it('rebuilds the exact DomesticShippingRates the fields were built from', () => {
    const result = parseShippingRateFields('domestic', domesticFields());
    expect(result).toEqual({ ok: true, rateId: 'domestic', rates: DEFAULT_DOMESTIC_SHIPPING });
  });

  it('accepts zero (free studio pickup) and two-decimal amounts', () => {
    const result = parseShippingRateFields('domestic', withValue(domesticFields(), 'kurier_pln', '29.99'));
    expect(result.ok).toBe(true);
    if (result.ok && result.rateId === 'domestic') expect(result.rates.pln.kurier).toBe(29.99);
  });

  it('rejects a negative amount', () => {
    const result = parseShippingRateFields('domestic', withValue(domesticFields(), 'kurier_pln', '-1'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors).toHaveProperty('kurier_pln');
  });

  it('rejects a third decimal place that toMinor() would silently round away', () => {
    const result = parseShippingRateFields('domestic', withValue(domesticFields(), 'paczkomat_pln', '20.005'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors).toHaveProperty('paczkomat_pln');
  });

  it('accepts a trailing-zero literal that IS a 2-decimal value', () => {
    const result = parseShippingRateFields('domestic', withValue(domesticFields(), 'paczkomat_pln', '20.500'));
    expect(result.ok).toBe(true);
    if (result.ok && result.rateId === 'domestic') expect(result.rates.pln.paczkomat).toBe(20.5);
  });

  it('rejects a missing key', () => {
    const result = parseShippingRateFields('domestic', domesticFields().filter((f) => f.key !== 'odbior_gbp'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors).toHaveProperty('odbior_gbp');
  });

  it('rejects a blank value', () => {
    const result = parseShippingRateFields('domestic', withValue(domesticFields(), 'odbior_eur', '   '));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors).toHaveProperty('odbior_eur');
  });

  it.each(['2e1', '+5', '0x10', 'Infinity', '1_000', '20,5'])(
    'rejects %s — a literal Number() would coerce but Postgres numeric input would not accept the same way',
    (raw) => {
      const result = parseShippingRateFields('domestic', withValue(domesticFields(), 'kurier_eur', raw));
      expect(result.ok).toBe(false);
    },
  );

  it('reports EVERY bad key at once, not one per round trip', () => {
    const broken = withValue(withValue(domesticFields(), 'kurier_pln', '-1'), 'odbior_gbp', 'abc');
    const result = parseShippingRateFields('domestic', broken);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.fieldErrors).sort()).toEqual(['kurier_pln', 'odbior_gbp']);
  });

  it('ignores unknown extra keys (same posture as parsePricingFields)', () => {
    const result = parseShippingRateFields('domestic', [...domesticFields(), numberField('region', 'EU')]);
    expect(result.ok).toBe(true);
  });
});

describe('parseShippingRateFields — international', () => {
  it('rebuilds the exact InternationalShippingRates the fields were built from', () => {
    const result = parseShippingRateFields('international', internationalFields());
    expect(result).toEqual({ ok: true, rateId: 'international', rates: DEFAULT_INTERNATIONAL_SHIPPING });
  });

  it('keeps 2-decimal Prodigi quotes exact across the round trip', () => {
    const result = parseShippingRateFields('international', internationalFields());
    expect(result.ok).toBe(true);
    if (result.ok && result.rateId === 'international') {
      expect(result.rates.CY.framed).toBe(132.43);
      expect(result.rates.GB.loose).toBe(5.66);
    }
  });

  it('rejects a missing country field', () => {
    const result = parseShippingRateFields(
      'international',
      internationalFields().filter((f) => f.key !== 'mt_framed_eur'),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors).toHaveProperty('mt_framed_eur');
  });

  it('rejects a negative country field', () => {
    const result = parseShippingRateFields('international', withValue(internationalFields(), 'pl_loose_eur', '-0.01'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors).toHaveProperty('pl_loose_eur');
  });

  it('never accepts a payload carrying an FX rate as if it were a shipping field', () => {
    // Defence in depth for the plan's named hazard: eur_to_pln is simply not a
    // key of this resource, so smuggling one in changes nothing.
    const result = parseShippingRateFields('international', [...internationalFields(), numberField('eur_to_pln', '9.99')]);
    expect(result.ok).toBe(true);
    if (result.ok && result.rateId === 'international') {
      expect(JSON.stringify(result.rates)).not.toContain('9.99');
    }
  });
});
