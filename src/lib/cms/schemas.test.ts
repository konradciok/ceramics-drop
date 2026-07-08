import { describe, expect, it } from 'vitest';
import { getPrintDesigns } from '@/lib/prints';
import { getProductsByCategory } from '@/lib/products';
import { collectionCopySchema, productNotesExpectedCount, validateProductNotesPayload } from './schemas';

describe('CMS product note schemas', () => {
  it('uses the current ceramic registry count for validation', () => {
    const count = getProductsByCategory('kubki').length;
    expect(productNotesExpectedCount('kubki')).toBe(count);

    const payload = validateProductNotesPayload('kubki', {
      notes: Array.from({ length: count }, (_, index) => `Opis ${index + 1}`),
    });

    expect(payload.notes).toHaveLength(count);
  });

  it('uses only published fine-art print designs for validation', () => {
    const count = getPrintDesigns().length;
    expect(productNotesExpectedCount('fine-art-prints')).toBe(count);
    expect(() => validateProductNotesPayload('fine-art-prints', {
      notes: Array.from({ length: count - 1 }, () => 'Opis'),
    })).toThrow(`Expected ${count} notes`);
  });

  it('rejects empty product notes before publish', () => {
    const count = getProductsByCategory('wazony').length;
    const notes = Array.from({ length: count }, () => 'Opis');
    notes[0] = ' ';
    expect(() => validateProductNotesPayload('wazony', { notes })).toThrow('Opis nie może być pusty');
  });
});

describe('CMS collection copy schema', () => {
  it('allows only the existing em rich tag in titles', () => {
    expect(collectionCopySchema.parse({
      eyebrow: 'Kolekcja',
      title: 'Kubki <em>recznie malowane</em>',
      lead: 'Krotki opis',
      metaDescription: 'Meta opis',
    }).title).toContain('<em>');

    expect(() => collectionCopySchema.parse({
      eyebrow: 'Kolekcja',
      title: 'Kubki <strong>nowe</strong>',
      lead: 'Krotki opis',
      metaDescription: 'Meta opis',
    })).toThrow('Dozwolony jest tylko znacznik <em>');
  });
});
