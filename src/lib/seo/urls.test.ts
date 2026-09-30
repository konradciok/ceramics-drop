import { describe, it, expect } from 'vitest';
import { absoluteUrl, alternatesFor, alternatesForIndexableLocales, languageAlternatesFor, productAlternates } from './urls';
import { SITE_URL } from '@/lib/site';

describe('absoluteUrl', () => {
  it('collapses the default-locale home to the bare origin (no trailing slash)', () => {
    expect(absoluteUrl('pl', '/')).toBe(SITE_URL);
  });

  it('omits the prefix for the default locale and prefixes the others', () => {
    expect(absoluteUrl('pl', '/kubki')).toBe(`${SITE_URL}/kubki`);
    expect(absoluteUrl('en', '/kubki')).toBe(`${SITE_URL}/en/kubki`);
    expect(absoluteUrl('es', '/kubki')).toBe(`${SITE_URL}/es/kubki`);
  });
});

describe('alternatesFor', () => {
  it('sets the canonical to the current locale', () => {
    expect(alternatesFor('pl', '/kubki')?.canonical).toBe(`${SITE_URL}/kubki`);
    expect(alternatesFor('en', '/kubki')?.canonical).toBe(`${SITE_URL}/en/kubki`);
  });

  it('emits one hreflang per locale plus x-default → default locale', () => {
    const languages = alternatesFor('en', '/kubki')?.languages as Record<string, string>;
    expect(languages.pl).toBe(`${SITE_URL}/kubki`);
    expect(languages.en).toBe(`${SITE_URL}/en/kubki`);
    expect(languages.es).toBe(`${SITE_URL}/es/kubki`);
    expect(languages['x-default']).toBe(languages.pl);
  });

  it('no longer emits gb / en-GB hreflang after the locale merge', () => {
    const languages = alternatesFor('en', '/kubki')?.languages as Record<string, string>;
    expect(languages['gb']).toBeUndefined();
    expect(languages['en-GB']).toBeUndefined();
    expect(languages['en']).toBe(`${SITE_URL}/en/kubki`);
  });
});

describe('productAlternates', () => {
  it('matches alternatesFor for the equivalent /slug/id path', () => {
    expect(productAlternates('pl', 'kubki', 'k01')).toEqual(alternatesFor('pl', '/kubki/k01'));
    expect(productAlternates('en', 'kubki', 'k01')).toEqual(alternatesFor('en', '/kubki/k01'));
  });

  it('sets the canonical to the current locale for a product URL', () => {
    expect(productAlternates('pl', 'kubki', 'k01')?.canonical).toBe(`${SITE_URL}/kubki/k01`);
    expect(productAlternates('en', 'kubki', 'k01')?.canonical).toBe(`${SITE_URL}/en/kubki/k01`);
  });

  it('emits reciprocal hreflang for every locale plus x-default on a product URL', () => {
    const languages = productAlternates('en', 'fine-art-prints', 'fap001')?.languages as Record<string, string>;
    expect(languages.pl).toBe(`${SITE_URL}/fine-art-prints/fap001`);
    expect(languages.en).toBe(`${SITE_URL}/en/fine-art-prints/fap001`);
    expect(languages.es).toBe(`${SITE_URL}/es/fine-art-prints/fap001`);
    expect(languages.de).toBe(`${SITE_URL}/de/fine-art-prints/fap001`);
    expect(languages['x-default']).toBe(languages.pl);
  });
});

describe('languageAlternatesFor', () => {
  it('lists only the given locales plus x-default', () => {
    expect(languageAlternatesFor('/kolekcje/linea', ['pl', 'de'])).toEqual({
      pl: `${SITE_URL}/kolekcje/linea`,
      de: `${SITE_URL}/de/kolekcje/linea`,
      'x-default': `${SITE_URL}/kolekcje/linea`,
    });
  });

  it('points x-default at the first listed locale when the default locale is not among them', () => {
    const languages = languageAlternatesFor('/kolekcje/linea', ['en', 'de']) as Record<string, string>;
    expect(languages['x-default']).toBe(`${SITE_URL}/en/kolekcje/linea`);
    expect(languages.pl).toBeUndefined();
  });

  it('declares no alternates for fewer than two locales', () => {
    expect(languageAlternatesFor('/kolekcje/linea', ['pl'])).toBeUndefined();
    expect(languageAlternatesFor('/kolekcje/linea', [])).toBeUndefined();
  });
});

describe('alternatesForIndexableLocales', () => {
  it('emits a reciprocal hreflang cluster over the indexable locales only', () => {
    const fromPl = alternatesForIndexableLocales('pl', '/kolekcje/linea', ['pl', 'de']);
    const fromDe = alternatesForIndexableLocales('de', '/kolekcje/linea', ['pl', 'de']);
    expect(fromPl?.canonical).toBe(`${SITE_URL}/kolekcje/linea`);
    expect(fromDe?.canonical).toBe(`${SITE_URL}/de/kolekcje/linea`);
    expect(fromPl?.languages).toEqual(fromDe?.languages);
    expect(Object.keys(fromPl?.languages as Record<string, string>).sort()).toEqual(['de', 'pl', 'x-default']);
  });

  it('omits hreflang on a page that is not itself indexable, keeping its own canonical', () => {
    const alternates = alternatesForIndexableLocales('en', '/kolekcje/linea', ['pl', 'de']);
    expect(alternates?.canonical).toBe(`${SITE_URL}/en/kolekcje/linea`);
    expect(alternates).not.toHaveProperty('languages');
  });

  it('omits hreflang when no locale is indexable', () => {
    expect(alternatesForIndexableLocales('pl', '/kolekcje/linea', [])).not.toHaveProperty('languages');
  });
});
