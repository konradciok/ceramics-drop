import { describe, expect, it } from 'vitest';
import de from '../../messages/de.json';
import en from '../../messages/en.json';
import es from '../../messages/es.json';
import pl from '../../messages/pl.json';
import { PRINT_DESIGNS, registryPrintDesigns } from './prints';
import {
  PRINT_COLLECTIONS,
  UNASSIGNED_COLLECTION,
  groupPrintDesigns,
} from './print-collections';
import type { PrintDesign } from './types';

describe('PRINT_COLLECTIONS integrity', () => {
  it('has unique slugs, none equal to the fallback', () => {
    const slugs = PRINT_COLLECTIONS.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).not.toContain(UNASSIGNED_COLLECTION);
  });

  it('every member id refers to a published registry design', () => {
    const published = new Map(PRINT_DESIGNS.filter((d) => d.published).map((d) => [d.id, d]));
    for (const { slug, designIds } of PRINT_COLLECTIONS) {
      for (const id of designIds) {
        expect(published.has(id), `${slug} → ${id} must be a published design`).toBe(true);
      }
    }
  });

  it('no design id appears in two collections', () => {
    const all = PRINT_COLLECTIONS.flatMap((c) => [...c.designIds]);
    expect(new Set(all).size).toBe(all.length);
  });

  it('derives its ordered members from the curation map', () => {
    expect(PRINT_COLLECTIONS.map((collection) => collection.designIds.length)).toEqual([5, 4, 4, 5, 5, 4, 4, 4, 4]);
  });
});

describe('groupPrintDesigns', () => {
  const published = registryPrintDesigns();

  it('groups every mapped registry design under its fixed curation name and display number', () => {
    const groups = groupPrintDesigns(published);
    expect(groups.map(({ name }) => name)).toEqual([
      'Ostrea', 'Gestures', 'Linea', 'Horizons', 'Portals',
      'Signs', 'Ciala', 'Balance', 'Verticles',
    ]);
    expect(groups.map(({ designs }) => designs.length)).toEqual([5, 4, 4, 5, 5, 4, 4, 4, 4]);
    expect(groups.flatMap(({ designs }) => designs.map(({ num }) => num))).toEqual(
      Array.from({ length: 39 }, (_, i) => String(i + 1).padStart(2, '0')),
    );
    expect(groups.some(({ slug }) => slug === UNASSIGNED_COLLECTION)).toBe(false);
  });

  it('keeps an unknown DB-created design in the localized fallback group', () => {
    const synthetic: PrintDesign = { ...published[0], id: 'fap999' };
    const groups = groupPrintDesigns([synthetic]);
    expect(groups).toEqual([{ slug: UNASSIGNED_COLLECTION, name: undefined, designs: [synthetic] }]);
  });
});

describe('i18n coverage', () => {
  it('keeps only the localized fallback name in every locale', () => {
    for (const messages of [pl, en, es, de]) {
      const names = (messages as Record<string, unknown>).printCollections as Record<string, string>;
      expect(Object.keys(names)).toEqual([UNASSIGNED_COLLECTION]);
      expect(names[UNASSIGNED_COLLECTION].length).toBeGreaterThan(0);
    }
  });
});
