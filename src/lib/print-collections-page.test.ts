import { describe, expect, it } from 'vitest';
import {
  collectionMetaDescription,
  indexableCollectionLocales,
  resolvePrintCollectionPage,
  splitCollectionDescription,
} from './print-collections';
import type { PrintCollectionDefinition } from './print-curation';
import type { PrintDesign } from './types';

const d = (id: string) => ({ id }) as PrintDesign;
const long = 'x'.repeat(100);
const def = (over: Partial<PrintCollectionDefinition> = {}): PrintCollectionDefinition => ({
  slug: 'linea', name: 'Linea', designIds: ['a', 'b', 'c'], prints: [], descriptions: { pl: long, en: 'Linea.' }, ...over,
});

describe('resolvePrintCollectionPage', () => {
  const designs = [d('a'), d('b'), d('c')];
  it('is indexable with real copy and >=3 prints', () => {
    expect(resolvePrintCollectionPage('linea', 'pl', designs, [def()])?.indexable).toBe(true);
  });
  it('is not indexable when the locale has only placeholder copy', () => {
    const p = resolvePrintCollectionPage('linea', 'en', designs, [def()]);
    expect(p?.description).toBeUndefined();
    expect(p?.indexable).toBe(false);
  });
  it('is not indexable when thin (<3 prints)', () => {
    expect(resolvePrintCollectionPage('linea', 'pl', designs.slice(0, 2), [def()])?.indexable).toBe(false);
  });
  it('never falls through to the "inne" bucket when the collection has nothing published', () => {
    // 'a' is defined but none of its designs are published; 'other' is published and unassigned to it.
    expect(resolvePrintCollectionPage('linea', 'pl', [d('other')], [def()])).toBeUndefined();
  });

  it('returns undefined for unknown slugs and empty groups', () => {
    expect(resolvePrintCollectionPage('nope', 'pl', designs, [def()])).toBeUndefined();
    expect(resolvePrintCollectionPage('linea', 'pl', [], [def()])).toBeUndefined();
  });
});

describe('indexableCollectionLocales', () => {
  const designs = [d('a'), d('b'), d('c')];

  it('lists exactly the locales that have real copy, in routing order', () => {
    const definitions = [def({ descriptions: { de: long, pl: long, en: 'Linea.' } })];
    expect(indexableCollectionLocales('linea', designs, definitions)).toEqual(['pl', 'de']);
  });

  it('is empty for a thin collection even with copy in every locale', () => {
    const definitions = [def({ descriptions: { pl: long, en: long, es: long, de: long } })];
    expect(indexableCollectionLocales('linea', designs.slice(0, 2), definitions)).toEqual([]);
  });

  it('is empty for an unknown slug', () => {
    expect(indexableCollectionLocales('nope', designs, [def()])).toEqual([]);
  });
});

describe('splitCollectionDescription', () => {
  it('splits into the first sentence and the rest', () => {
    expect(splitCollectionDescription('Pierwsze zdanie. Drugie zdanie. Trzecie.')).toEqual({
      lead: 'Pierwsze zdanie.',
      rest: 'Drugie zdanie. Trzecie.',
    });
  });

  it('has no rest for a one-sentence text and trims whitespace', () => {
    expect(splitCollectionDescription('  Jedno zdanie.  ')).toEqual({ lead: 'Jedno zdanie.' });
  });

  it('keeps a text with no terminal punctuation as the lead', () => {
    expect(splitCollectionDescription('Bez kropki na końcu')).toEqual({ lead: 'Bez kropki na końcu' });
  });

  it('does not split on a dash or a comma', () => {
    const text = 'Formy — owale, pierścienie — układają się w rytm. Reszta.';
    expect(splitCollectionDescription(text).lead).toBe('Formy — owale, pierścienie — układają się w rytm.');
  });
});

describe('collectionMetaDescription', () => {
  const s1 = 'A'.repeat(60) + '.';
  const s2 = 'B'.repeat(60) + '.';
  const s3 = 'C'.repeat(60) + '.';

  it('packs whole sentences up to the limit and never breaks one', () => {
    const out = collectionMetaDescription(`${s1} ${s2} ${s3}`, 155);
    expect(out).toBe(`${s1} ${s2}`);
    expect(out.length).toBeLessThanOrEqual(155);
    expect(out.endsWith('.')).toBe(true);
  });

  it('returns the whole text when it already fits', () => {
    expect(collectionMetaDescription(`${s1} ${s2}`, 155)).toBe(`${s1} ${s2}`);
  });

  it('cuts on a word boundary with an ellipsis when the first sentence alone is too long', () => {
    const long = `${'słowo '.repeat(40)}koniec.`;
    const out = collectionMetaDescription(long, 50);
    expect(out.length).toBeLessThanOrEqual(50);
    expect(out.endsWith('…')).toBe(true);
    expect(out.slice(0, -1)).toMatch(/słowo$/);
  });
});
