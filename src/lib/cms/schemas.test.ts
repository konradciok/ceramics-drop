import { describe, expect, it } from 'vitest';
import { registryProductsByCategory } from '@/lib/products';
import { collectionCopySchema, homePageSchema, printPdpSchema, productNoteIds, validateCmsPayload, validateProductNotesPayload } from './schemas';

function notesFor(ids: string[], fill = 'Opis'): Record<string, string> {
  return Object.fromEntries(ids.map((id) => [id, fill]));
}

describe('CMS product note schemas', () => {
  it('accepts a payload keyed by the live ceramic registry ids', () => {
    const ids = registryProductsByCategory('kubki').map((product) => product.id);
    expect(productNoteIds('kubki')).toEqual(ids);

    const payload = validateProductNotesPayload('kubki', { notes: notesFor(ids, 'Opis kubka') });
    expect(Object.keys(payload.notes).sort()).toEqual([...ids].sort());
  });

  it('no longer treats fine-art-prints as a product notes document (prints left the store)', () => {
    expect(productNoteIds('fine-art-prints')).toBeNull();
    expect(() => validateProductNotesPayload('fine-art-prints', { notes: {} })).toThrow('Nieznany dokument notatek');
  });

  it('rejects a payload missing a product id (catalogue reorder must not drop a note)', () => {
    const ids = registryProductsByCategory('wazony').map((product) => product.id);
    const incomplete = notesFor(ids);
    delete incomplete[ids[0]];
    expect(() => validateProductNotesPayload('wazony', { notes: incomplete })).toThrow(`Brak opisu dla ${ids[0]}`);
  });

  it('rejects an unknown id that is no longer in the registry', () => {
    const ids = registryProductsByCategory('wazony').map((product) => product.id);
    const stale = notesFor(ids);
    stale['zz-stale-id'] = 'Opis';
    expect(() => validateProductNotesPayload('wazony', { notes: stale })).toThrow('Nieznany identyfikator zz-stale-id');
  });

  it('read mode drops a stale id instead of rejecting the whole document', () => {
    // Regression: ids that left the catalogue while the published notes still
    // carried them made every PDP in that document fall back to the message
    // files in all four locales (Sentry CERAMICS-DROP-1S/1T).
    const ids = registryProductsByCategory('wazony').map((product) => product.id);
    const stale = notesFor(ids);
    stale['zz-stale-id'] = 'Opis';
    const payload = validateProductNotesPayload('wazony', { notes: stale }, { lenient: true });
    expect(Object.keys(payload.notes).sort()).toEqual([...ids].sort());
  });

  it('read mode tolerates a missing id (a newly added piece falls back per id, not per document)', () => {
    const ids = registryProductsByCategory('wazony').map((product) => product.id);
    const incomplete = notesFor(ids);
    delete incomplete[ids[0]];
    const payload = validateProductNotesPayload('wazony', { notes: incomplete }, { lenient: true });
    expect(payload.notes).not.toHaveProperty(ids[0]);
    expect(Object.keys(payload.notes)).toHaveLength(ids.length - 1);
  });

  it('read mode still rejects an unknown document slug', () => {
    expect(() => validateProductNotesPayload('nope', { notes: {} }, { lenient: true })).toThrow('Nieznany dokument notatek');
  });

  it('rejects empty product notes before publish', () => {
    const ids = registryProductsByCategory('wazony').map((product) => product.id);
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

describe('CMS print-pdp schema (gift-card artist band)', () => {
  const full = {
    artist: { name: 'Anna Ciok', bio: 'Bio artystki.' },
  };

  it('accepts a fully populated payload', () => {
    expect(() => printPdpSchema.parse(full)).not.toThrow();
  });

  it('accepts empty fields (empty = section disabled, unlike other CMS schemas)', () => {
    const empty = {
      artist: { name: '', bio: '' },
    };
    expect(printPdpSchema.parse(empty).artist.bio).toBe('');
  });

  it('trims whitespace-only fields to empty', () => {
    expect(printPdpSchema.parse({ ...full, artist: { name: '  ', bio: ' x ' } }).artist).toEqual({ name: '', bio: 'x' });
  });

  it('rejects markup in any field', () => {
    expect(() => printPdpSchema.parse({ artist: { ...full.artist, bio: '<b>bio</b>' } }))
      .toThrow('To pole obsługuje tylko zwykły tekst');
  });

  it('is reachable through validateCmsPayload under page:print-pdp', () => {
    expect(() => validateCmsPayload('page', 'print-pdp', full)).not.toThrow();
    expect(() => validateCmsPayload('page', 'unknown-page', full)).toThrow();
  });

  it('drops the retired print accordions from an old payload', () => {
    const old = { ...full, accordions: { productDetails: 'Papier EMA.', framing: 'Rama.', shipping: 'Prodigi.' } };
    expect(printPdpSchema.parse(old)).toEqual(full);
  });

  it('rejects a payload missing the artist object', () => {
    expect(() => printPdpSchema.parse({})).toThrow();
  });
});

describe('CMS home page schema', () => {
  const imageKey = `${'a'.repeat(64)}.webp`;
  const videoKey = `${'b'.repeat(64)}.mp4`;
  const posterKey = `${'c'.repeat(64)}.jpg`;

  const base = {
    heroLine1: 'Ręcznie malowane,',
    heroLine2: 'jedna sztuka naraz.',
    heroTagline: 'PRACOWNIA ANNY CIOK',
    ctaLabel: 'Przeglądaj sklep',
    heroAlt: 'Ręcznie malowane naczynia ceramiczne',
  };

  it('accepts null media slots', () => {
    expect(() => homePageSchema.parse({ ...base, media: { desktop: null, mobile: null } })).not.toThrow();
  });

  it('accepts a valid image slot', () => {
    const media = { desktop: { kind: 'image', key: imageKey, width: 1600, height: 900 }, mobile: null };
    expect(homePageSchema.parse({ ...base, media }).media.desktop).toEqual(media.desktop);
  });

  it('accepts a valid video slot with a poster image', () => {
    const media = {
      desktop: { kind: 'video', key: videoKey, poster: { key: posterKey, width: 1600, height: 900 } },
      mobile: null,
    };
    expect(() => homePageSchema.parse({ ...base, media })).not.toThrow();
  });

  it('rejects a video slot missing its poster', () => {
    const media = { desktop: { kind: 'video', key: videoKey }, mobile: null };
    expect(() => homePageSchema.parse({ ...base, media })).toThrow();
  });

  it('rejects a malformed media key', () => {
    const media = { desktop: { kind: 'image', key: 'not-a-valid-key.webp', width: 1600, height: 900 }, mobile: null };
    expect(() => homePageSchema.parse({ ...base, media })).toThrow();
  });

  it('rejects markup/script content in copy fields', () => {
    const media = { desktop: null, mobile: null };
    expect(() => homePageSchema.parse({ ...base, heroLine1: '<script>alert(1)</script>', media })).toThrow(
      'To pole obsługuje tylko zwykły tekst',
    );
  });

  it('is reachable through validateCmsPayload under page:home', () => {
    const media = { desktop: null, mobile: null };
    expect(() => validateCmsPayload('page', 'home', { ...base, media })).not.toThrow();
  });
});
