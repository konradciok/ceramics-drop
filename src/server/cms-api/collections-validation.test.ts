import { describe, expect, it } from 'vitest';
import { validateCollectionCreate, validateCollectionSave } from './collections-validation';

const validField = {
  key: 'headline',
  label: 'Headline',
  type: 'text',
  value: 'Wiosenna kolekcja',
  locale: 'pl',
  sourceLocale: 'pl',
};

describe('validateCollectionCreate', () => {
  it('accepts a valid name', () => {
    const result = validateCollectionCreate({ name: 'Wiosna 2026' });
    expect(result).toEqual({ ok: true, data: { name: 'Wiosna 2026' } });
  });

  it('rejects a blank name', () => {
    const result = validateCollectionCreate({ name: '' });
    expect(result.ok).toBe(false);
  });

  it('rejects a whitespace-only name', () => {
    const result = validateCollectionCreate({ name: '   ' });
    expect(result.ok).toBe(false);
  });

  it('rejects a missing name', () => {
    const result = validateCollectionCreate({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors.name).toBeDefined();
  });

  it('rejects extra properties not in the contract (additionalProperties: false)', () => {
    const result = validateCollectionCreate({ name: 'Wiosna', mysteryField: true });
    expect(result.ok).toBe(false);
  });
});

describe('validateCollectionSave', () => {
  const validBody = { expectedRevision: 1, name: 'Wiosna 2026', fields: [validField] };

  it('accepts a valid save body', () => {
    const result = validateCollectionSave(validBody);
    expect(result).toEqual({ ok: true, data: validBody });
  });

  it('accepts an empty fields array (no minItems in the contract)', () => {
    const result = validateCollectionSave({ expectedRevision: 0, name: 'Nowa kolekcja', fields: [] });
    expect(result.ok).toBe(true);
  });

  it('accepts every documented field type', () => {
    for (const type of ['text', 'richtext', 'number', 'productIds']) {
      const result = validateCollectionSave({ ...validBody, fields: [{ ...validField, type }] });
      expect(result.ok).toBe(true);
    }
  });

  it('accepts every documented locale/sourceLocale value', () => {
    for (const locale of ['pl', 'en', 'es', 'de', 'none']) {
      const result = validateCollectionSave({ ...validBody, fields: [{ ...validField, locale, sourceLocale: locale }] });
      expect(result.ok).toBe(true);
    }
  });

  it('rejects an unknown field type', () => {
    const result = validateCollectionSave({ ...validBody, fields: [{ ...validField, type: 'boolean' }] });
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown locale', () => {
    const result = validateCollectionSave({ ...validBody, fields: [{ ...validField, locale: 'fr' }] });
    expect(result.ok).toBe(false);
  });

  it('rejects a field missing a required key (e.g. sourceLocale)', () => {
    const incompleteField: Record<string, unknown> = { ...validField };
    delete incompleteField.sourceLocale;
    const result = validateCollectionSave({ ...validBody, fields: [incompleteField] });
    expect(result.ok).toBe(false);
  });

  it('rejects a field with extra properties (additionalProperties: false)', () => {
    const result = validateCollectionSave({ ...validBody, fields: [{ ...validField, extra: 'nope' }] });
    expect(result.ok).toBe(false);
  });

  it('rejects a non-integer expectedRevision', () => {
    const result = validateCollectionSave({ ...validBody, expectedRevision: 1.5 });
    expect(result.ok).toBe(false);
  });

  it('rejects a missing expectedRevision', () => {
    const rest: Record<string, unknown> = { ...validBody };
    delete rest.expectedRevision;
    const result = validateCollectionSave(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors.expectedRevision).toBeDefined();
  });

  it('rejects a blank name', () => {
    const result = validateCollectionSave({ ...validBody, name: '  ' });
    expect(result.ok).toBe(false);
  });

  it('rejects the products-shaped {expectedRevision, draft} body (no draft wrapper for collections)', () => {
    const result = validateCollectionSave({ expectedRevision: 1, draft: { name: 'x', fields: [] } });
    expect(result.ok).toBe(false);
  });

  it('rejects extra top-level properties not in the contract (additionalProperties: false)', () => {
    const result = validateCollectionSave({ ...validBody, mysteryField: true });
    expect(result.ok).toBe(false);
  });
});
