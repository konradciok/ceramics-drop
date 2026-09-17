import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePricingFields, validatePricingSave } from './pricing-validation';
import { PRICING_FIELD_DEFS, buildPricingFields } from './pricing-mapping';
import { DEFAULT_PRINT_PRICING } from '@/lib/print-pricing';
import type { Field } from './types';

// The live singleton's own migration — the canonical statement of every range
// this module must re-validate before publish.
const PRINT_PRICING_MIGRATION = join(
  __dirname,
  '../../../supabase/migrations/20260807120000_print_pricing_config.sql',
);

function fieldsFrom(overrides: Record<string, string> = {}): Field[] {
  return buildPricingFields(DEFAULT_PRINT_PRICING).map((f) =>
    f.key in overrides ? { ...f, value: overrides[f.key] } : f,
  );
}

function errorsFor(overrides: Record<string, string>): Record<string, string> {
  const result = parsePricingFields(fieldsFrom(overrides));
  return result.ok ? {} : result.fieldErrors;
}

describe('parsePricingFields — happy path', () => {
  it('parses the 11 default fields back into exactly DEFAULT_PRINT_PRICING', () => {
    const result = parsePricingFields(fieldsFrom());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toEqual(DEFAULT_PRINT_PRICING);
  });

  it('is order-independent', () => {
    const shuffled = [...fieldsFrom()].reverse();
    const result = parsePricingFields(shuffled);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toEqual(DEFAULT_PRINT_PRICING);
  });

  it('ignores unknown extra keys', () => {
    const extra: Field = { key: 'not_a_pricing_key', label: 'x', type: 'number', value: '9', locale: 'none', sourceLocale: 'none' };
    const result = parsePricingFields([...fieldsFrom(), extra]);
    expect(result.ok).toBe(true);
  });

  it('resolves duplicate keys to the last occurrence (same as the RPC jsonb_object_agg)', () => {
    const dup: Field = { key: 'base_30x40_eur', label: 'x', type: 'number', value: '99', locale: 'none', sourceLocale: 'none' };
    const result = parsePricingFields([...fieldsFrom(), dup]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.baseEur['30x40']).toBe(99);
  });

  it('tolerates surrounding whitespace in a value', () => {
    expect(errorsFor({ base_30x40_eur: '  25  ' })).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// FX-rate round-trip. The two rates are the only non-integer values in the
// resource, and the only place a silent precision change could hide.
// ---------------------------------------------------------------------------
describe('parsePricingFields — FX rate round-trip', () => {
  it.each([
    ['4.25', 4.25],
    ['4.2500', 4.25],
    ['0.86', 0.86],
    ['0.8600', 0.86],
    ['0.0001', 0.0001],
    ['100', 100],
    ['4', 4],
  ])('maps eur_to_pln %s to exactly %s', (value, expected) => {
    const result = parsePricingFields(fieldsFrom({ eur_to_pln: value }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.eurToPln).toBe(expected);
  });

  it('round-trips config -> fields -> config without drift for a 4-decimal rate', () => {
    const config = { ...DEFAULT_PRINT_PRICING, eurToPln: 4.2137, eurToGbp: 0.8611 };
    const result = parsePricingFields(buildPricingFields(config));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config).toEqual(config);
  });
});

// ---------------------------------------------------------------------------
// Boundary coverage, stated SIDE BY SIDE with the DB CHECK constraints these
// ranges re-encode. EXPECTED_CHECKS is asserted against the actual migration
// text below, so a constraint change that this validator does not follow fails
// here rather than surfacing as an opaque 23514 in production.
// ---------------------------------------------------------------------------
const EXPECTED_CHECKS: Record<string, string> = {
  base_30x40_eur: 'base_30x40_eur > 0',
  base_50x70_eur: 'base_50x70_eur > 0',
  base_70x100_eur: 'base_70x100_eur > 0',
  frame_30x40_eur: 'frame_30x40_eur >= 0',
  frame_50x70_eur: 'frame_50x70_eur >= 0',
  frame_70x100_eur: 'frame_70x100_eur >= 0',
  mount_30x40_eur: 'mount_30x40_eur >= 0',
  mount_50x70_eur: 'mount_50x70_eur >= 0',
  mount_70x100_eur: 'mount_70x100_eur >= 0',
  eur_to_pln: 'eur_to_pln > 0 and eur_to_pln <= 100',
  eur_to_gbp: 'eur_to_gbp > 0 and eur_to_gbp <= 100',
};

const EXPECTED_TYPES: Record<string, string> = {
  base_30x40_eur: 'integer',
  base_50x70_eur: 'integer',
  base_70x100_eur: 'integer',
  frame_30x40_eur: 'integer',
  frame_50x70_eur: 'integer',
  frame_70x100_eur: 'integer',
  mount_30x40_eur: 'integer',
  mount_50x70_eur: 'integer',
  mount_70x100_eur: 'integer',
  eur_to_pln: 'numeric(8,4)',
  eur_to_gbp: 'numeric(8,4)',
};

describe('print_pricing_config CHECK constraints (parsed from the migration)', () => {
  const sql = readFileSync(PRINT_PRICING_MIGRATION, 'utf8');
  const parsed: Record<string, { type: string; check: string }> = {};
  for (const line of sql.split('\n')) {
    const m = line.match(/^\s*(\w+)\s+(integer|numeric\(8,4\))\s+not null\s+check\s*\((.+?)\)\s*,?\s*$/);
    if (m) parsed[m[1]] = { type: m[2], check: m[3].replace(/\s+/g, ' ').trim() };
  }

  it('parses exactly the 11 value columns this resource maps', () => {
    expect(Object.keys(parsed).sort()).toEqual(Object.keys(EXPECTED_CHECKS).sort());
    expect(Object.keys(parsed).sort()).toEqual(PRICING_FIELD_DEFS.map((d) => d.key).sort());
  });

  it('still encodes exactly the ranges this validator re-checks', () => {
    expect(Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, v.check]))).toEqual(EXPECTED_CHECKS);
  });

  it('still uses the column types this validator assumes (integer EUR, numeric(8,4) rates)', () => {
    expect(Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, v.type]))).toEqual(EXPECTED_TYPES);
  });
});

describe('parsePricingFields — base_*_eur boundaries (DB: integer, check > 0)', () => {
  const baseKeys = ['base_30x40_eur', 'base_50x70_eur', 'base_70x100_eur'] as const;

  it.each(baseKeys)('%s accepts 1, the smallest value satisfying "> 0"', (key) => {
    expect(errorsFor({ [key]: '1' })).toEqual({});
  });

  it.each(baseKeys)('%s rejects 0 — "> 0" is strict', (key) => {
    expect(errorsFor({ [key]: '0' })).toHaveProperty(key);
  });

  it.each(baseKeys)('%s rejects a negative value', (key) => {
    expect(errorsFor({ [key]: '-1' })).toHaveProperty(key);
  });

  it.each(baseKeys)('%s rejects a fractional value (column is integer)', (key) => {
    expect(errorsFor({ [key]: '25.5' })).toHaveProperty(key);
  });

  it.each(baseKeys)('%s rejects a blank value', (key) => {
    expect(errorsFor({ [key]: '' })).toHaveProperty(key);
  });

  it.each(baseKeys)('%s rejects a non-numeric value', (key) => {
    expect(errorsFor({ [key]: 'dwadzieścia pięć' })).toHaveProperty(key);
  });

  it.each(baseKeys)('%s rejects an exponent literal (Number() would accept it; Postgres integer input would not)', (key) => {
    expect(errorsFor({ [key]: '2e1' })).toHaveProperty(key);
  });
});

describe('parsePricingFields — frame_*/mount_*_eur boundaries (DB: integer, check >= 0)', () => {
  const zeroOkKeys = [
    'frame_30x40_eur',
    'frame_50x70_eur',
    'frame_70x100_eur',
    'mount_30x40_eur',
    'mount_50x70_eur',
    'mount_70x100_eur',
  ] as const;

  it.each(zeroOkKeys)('%s ACCEPTS 0 — ">= 0", unlike base_*', (key) => {
    expect(errorsFor({ [key]: '0' })).toEqual({});
  });

  it.each(zeroOkKeys)('%s rejects -1', (key) => {
    expect(errorsFor({ [key]: '-1' })).toHaveProperty(key);
  });

  it.each(zeroOkKeys)('%s rejects a fractional value', (key) => {
    expect(errorsFor({ [key]: '0.5' })).toHaveProperty(key);
  });
});

describe('parsePricingFields — eur_to_* boundaries (DB: numeric(8,4), check > 0 and <= 100)', () => {
  const rateKeys = ['eur_to_pln', 'eur_to_gbp'] as const;

  it.each(rateKeys)('%s rejects 0 — "> 0" is strict', (key) => {
    expect(errorsFor({ [key]: '0' })).toHaveProperty(key);
  });

  it.each(rateKeys)('%s accepts 0.0001, the smallest positive value numeric(8,4) can hold', (key) => {
    expect(errorsFor({ [key]: '0.0001' })).toEqual({});
  });

  it.each(rateKeys)('%s ACCEPTS exactly 100 — "<= 100" is inclusive', (key) => {
    expect(errorsFor({ [key]: '100' })).toEqual({});
  });

  it.each(rateKeys)('%s rejects 100.0001, just past the inclusive upper bound', (key) => {
    expect(errorsFor({ [key]: '100.0001' })).toHaveProperty(key);
  });

  it.each(rateKeys)('%s rejects a negative rate', (key) => {
    expect(errorsFor({ [key]: '-4.25' })).toHaveProperty(key);
  });

  it.each(rateKeys)('%s rejects a 5-decimal rate that numeric(8,4) would SILENTLY ROUND', (key) => {
    expect(errorsFor({ [key]: '4.25005' })).toHaveProperty(key);
  });

  it.each(rateKeys)('%s accepts a 4-decimal rate', (key) => {
    expect(errorsFor({ [key]: '4.2137' })).toEqual({});
  });

  // Trailing zeros are not precision. '4.25000' IS 4.25, and numeric(8,4)
  // stores it exactly — rejecting it would diverge from the RPC, whose scale
  // test is "v x 10000 is a whole number", not "count the literal's digits".
  it.each(rateKeys)('%s accepts a value padded past 4 decimals with zeros', (key) => {
    expect(errorsFor({ [key]: '4.25000' })).toEqual({});
  });

  it.each(rateKeys)('%s rejects a blank value', (key) => {
    expect(errorsFor({ [key]: '' })).toHaveProperty(key);
  });
});

describe('parsePricingFields — missing keys', () => {
  it('reports every one of the 11 keys when fields is empty', () => {
    const result = parsePricingFields([]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.fieldErrors).sort()).toEqual(PRICING_FIELD_DEFS.map((d) => d.key).sort());
  });

  it('reports only the dropped key when one field is missing', () => {
    const missing = fieldsFrom().filter((f) => f.key !== 'eur_to_gbp');
    const result = parsePricingFields(missing);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.fieldErrors)).toEqual(['eur_to_gbp']);
  });

  it('reports several bad keys at once rather than stopping at the first', () => {
    const errors = errorsFor({ base_30x40_eur: '0', eur_to_pln: '0', mount_50x70_eur: '-3' });
    expect(Object.keys(errors).sort()).toEqual(['base_30x40_eur', 'eur_to_pln', 'mount_50x70_eur']);
  });

  it('keys every error by the Field key (== print_pricing_config column name), never by the zod config path', () => {
    const errors = errorsFor({ base_30x40_eur: '0', eur_to_pln: '0' });
    expect(Object.keys(errors)).not.toContain('baseEur.30x40');
    expect(Object.keys(errors)).not.toContain('eurToPln');
    for (const message of Object.values(errors)) expect(typeof message).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// The generic ResourceSave wrapper — same contract every resource kind shares.
// ---------------------------------------------------------------------------
describe('validatePricingSave', () => {
  const validFields = fieldsFrom();

  it('accepts a well-formed ResourceSave body', () => {
    const result = validatePricingSave({ expectedRevision: 1, name: 'Cennik Fine Art Print', fields: validFields });
    expect(result.ok).toBe(true);
  });

  it('requires expectedRevision', () => {
    const result = validatePricingSave({ name: 'x', fields: validFields });
    expect(result.ok).toBe(false);
  });

  it('rejects a draft wrapper (ResourceSave is top-level)', () => {
    const result = validatePricingSave({ expectedRevision: 1, draft: { name: 'x', fields: validFields } });
    expect(result.ok).toBe(false);
  });

  it('rejects a malformed field', () => {
    const result = validatePricingSave({ expectedRevision: 1, name: 'x', fields: [{ key: 'base_30x40_eur' }] });
    expect(result.ok).toBe(false);
  });

  it('does NOT range-check at save time — a draft may hold out-of-range values mid-edit', () => {
    const result = validatePricingSave({
      expectedRevision: 1,
      name: 'x',
      fields: fieldsFrom({ base_30x40_eur: '0', eur_to_pln: '999' }),
    });
    expect(result.ok).toBe(true);
  });
});
