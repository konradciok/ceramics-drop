import { describe, expect, it } from 'vitest';
import { getPrintDesigns } from '@/lib/prints';
import { getProductsByCategory } from '@/lib/products';
import { collectionCopySchema, productNoteIds, validateProductNotesPayload } from './schemas';

function notesFor(ids: string[], fill = 'Opis'): Record<string, string> {
  return Object.fromEntries(ids.map((id) => [id, fill]));
}

describe('CMS product note schemas', () => {
  it('accepts a payload keyed by the live ceramic registry ids', () => {
    const ids = getProductsByCategory('kubki').map((product) => product.id);
    expect(productNoteIds('kubki')).toEqual(ids);

    const payload = validateProductNotesPayload('kubki', { notes: notesFor(ids, 'Opis kubka') });
    expect(Object.keys(payload.notes).sort()).toEqual([...ids].sort());
  });

  it('accepts a payload keyed by published fine-art print design ids', () => {
    const ids = getPrintDesigns().map((design) => design.id);
    expect(productNoteIds('fine-art-prints')).toEqual(ids);
    expect(() => validateProductNotesPayload('fine-art-prints', { notes: notesFor(ids) })).not.toThrow();
  });

  it('rejects a payload missing a product id (catalogue reorder must not drop a note)', () => {
    const ids = getProductsByCategory('wazony').map((product) => product.id);
    const incomplete = notesFor(ids);
    delete incomplete[ids[0]];
    expect(() => validateProductNotesPayload('wazony', { notes: incomplete })).toThrow(`Brak opisu dla ${ids[0]}`);
  });

  it('rejects an unknown id that is no longer in the registry', () => {
    const ids = getProductsByCategory('wazony').map((product) => product.id);
    const stale = notesFor(ids);
    stale['zz-stale-id'] = 'Opis';
    expect(() => validateProductNotesPayload('wazony', { notes: stale })).toThrow('Nieznany identyfikator zz-stale-id');
  });

  it('rejects empty product notes before publish', () => {
    const ids = getProductsByCategory('wazony').map((product) => product.id);
    const notes = notesFor(ids);
    notes[ids[0]] = ' ';
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
