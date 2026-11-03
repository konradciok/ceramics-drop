import { describe, expect, it } from 'vitest';
import { validateContentSave } from './content-validation';

const validField = { key: 'kubki-01', label: 'Kubki Nº 01', type: 'text', value: 'A note', locale: 'none', sourceLocale: 'none' };

describe('validateContentSave', () => {
  it('accepts a well-formed ResourceSave body', () => {
    const result = validateContentSave({ expectedRevision: 1, name: 'kubki', fields: [validField] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.expectedRevision).toBe(1);
      expect(result.data.fields).toEqual([validField]);
    }
  });

  it('rejects a missing expectedRevision', () => {
    const result = validateContentSave({ name: 'kubki', fields: [validField] });
    expect(result.ok).toBe(false);
  });

  it('rejects a fractional expectedRevision', () => {
    const result = validateContentSave({ expectedRevision: 1.5, name: 'kubki', fields: [validField] });
    expect(result.ok).toBe(false);
  });

  it('rejects a blank name', () => {
    const result = validateContentSave({ expectedRevision: 1, name: '   ', fields: [validField] });
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown field type', () => {
    const result = validateContentSave({ expectedRevision: 1, name: 'kubki', fields: [{ ...validField, type: 'bogus' }] });
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown field locale', () => {
    const result = validateContentSave({ expectedRevision: 1, name: 'kubki', fields: [{ ...validField, locale: 'fr' }] });
    expect(result.ok).toBe(false);
  });

  it('rejects extra top-level properties (strict object)', () => {
    const result = validateContentSave({ expectedRevision: 1, name: 'kubki', fields: [validField], draft: {} });
    expect(result.ok).toBe(false);
  });

  it('rejects extra field properties (strict object)', () => {
    const result = validateContentSave({ expectedRevision: 1, name: 'kubki', fields: [{ ...validField, extra: true }] });
    expect(result.ok).toBe(false);
  });

  it('returns fieldErrors keyed by dotted path on failure', () => {
    const result = validateContentSave({ expectedRevision: 1, name: '', fields: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors).toHaveProperty('name');
    }
  });

  it('accepts an empty fields array', () => {
    const result = validateContentSave({ expectedRevision: 1, name: 'kubki', fields: [] });
    expect(result.ok).toBe(true);
  });
});
