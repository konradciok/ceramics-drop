import { describe, expect, it } from 'vitest';
import { CMS_LOCALES } from './types';
import { fallbackPrintPdpPayload, splitParagraphs } from './print-pdp';

describe('fallbackPrintPdpPayload', () => {
  it.each(CMS_LOCALES)('builds a complete non-empty payload for %s', (locale) => {
    const payload = fallbackPrintPdpPayload(locale);
    expect(payload.artist.name).toBe('Anna Ciok');
    expect(payload.artist.bio.length).toBeGreaterThan(20);
    expect(payload.accordions.productDetails.length).toBeGreaterThan(20);
    expect(payload.accordions.framing.length).toBeGreaterThan(20);
    expect(payload.accordions.shipping.length).toBeGreaterThan(20);
  });
});

describe('splitParagraphs', () => {
  it('splits on blank lines and trims', () => {
    expect(splitParagraphs('Pierwszy akapit.\n\n  Drugi akapit. ')).toEqual(['Pierwszy akapit.', 'Drugi akapit.']);
  });

  it('keeps single newlines inside one paragraph', () => {
    expect(splitParagraphs('linia 1\nlinia 2')).toEqual(['linia 1\nlinia 2']);
  });

  it('drops empty segments', () => {
    expect(splitParagraphs('\n\n a \n\n\n\n b \n\n')).toEqual(['a', 'b']);
    expect(splitParagraphs('')).toEqual([]);
    expect(splitParagraphs('   ')).toEqual([]);
  });
});
