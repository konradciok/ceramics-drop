import { describe, it, expect } from 'vitest';
import { absoluteUrl, alternatesFor, productAlternates } from './urls';
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
