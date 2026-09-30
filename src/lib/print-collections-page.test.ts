import { describe, expect, it } from 'vitest';
import { resolvePrintCollectionPage } from './print-collections';
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
