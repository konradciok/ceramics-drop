import { describe, expect, it } from 'vitest';
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

  // The 2026-08-06 curation (fap005–fap047) was retired with the 2026-08-17
  // registry reset. PRINT_COLLECTIONS is deliberately empty pending a real
  // curatorial pass over the new fap001–fap041 batch — see print-collections.ts.
  it('is empty pending re-curation of the 2026-08-17 batch', () => {
    expect(PRINT_COLLECTIONS).toEqual([]);
  });
});

describe('groupPrintDesigns', () => {
  const published = registryPrintDesigns().filter((d) => d.published);

  it('with no collections curated yet, every published design falls into the inne fallback', () => {
    const groups = groupPrintDesigns(published);
    expect(groups).toHaveLength(1);
    expect(groups[0].slug).toBe(UNASSIGNED_COLLECTION);
    const flat = groups[0].designs.map((d) => d.id);
    expect(new Set(flat).size).toBe(flat.length);
    expect(flat.sort()).toEqual(published.map((d) => d.id).sort());
  });

  it('unknown ids fall back to inne; empty groups are dropped', () => {
    const synthetic: PrintDesign = { ...published[0], id: 'fap999' };
    const groups = groupPrintDesigns([synthetic]);
    expect(groups).toEqual([{ slug: UNASSIGNED_COLLECTION, designs: [synthetic] }]);
  });
});

describe('i18n coverage', () => {
  it('pl has a non-empty printCollections name for every slug + fallback', () => {
    const names = (pl as Record<string, unknown>).printCollections as Record<string, string>;
    for (const slug of [...PRINT_COLLECTIONS.map((c) => c.slug), UNASSIGNED_COLLECTION]) {
      expect(typeof names?.[slug], `printCollections.${slug} missing in pl.json`).toBe('string');
      expect(names[slug].length).toBeGreaterThan(0);
    }
  });
});
