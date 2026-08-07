import { describe, expect, it } from 'vitest';
import pl from '../../messages/pl.json';
import { PRINT_DESIGNS, registryPrintDesigns } from './prints';
import {
  PRINT_COLLECTIONS,
  UNASSIGNED_COLLECTION,
  collectionOf,
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

  it('covers all 43 full-bleed designs (fap005–fap047)', () => {
    const fullBleed = PRINT_DESIGNS.filter((d) => /^fap0\d\d$/.test(d.id));
    expect(fullBleed).toHaveLength(43);
    for (const d of fullBleed) {
      expect(collectionOf(d.id), `${d.id} must be assigned`).toBeDefined();
    }
  });
});

describe('groupPrintDesigns', () => {
  const published = registryPrintDesigns().filter((d) => d.published);

  it('covers every published design exactly once, in collection order', () => {
    const groups = groupPrintDesigns(published);
    // fap01-03 withdrawn 2026-08-06: every published design is curated, so
    // the 'inne' fallback bucket is empty and dropped.
    expect(groups.map((g) => g.slug)).toEqual(PRINT_COLLECTIONS.map((c) => c.slug));
    const flat = groups.flatMap((g) => g.designs.map((d) => d.id));
    expect(new Set(flat).size).toBe(flat.length);
    expect(flat.sort()).toEqual(published.map((d) => d.id).sort());
  });

  it('withdrawn fap01–fap03 are unpublished and stay unassigned (fallback would catch them)', () => {
    for (const id of ['fap01', 'fap02', 'fap03']) {
      expect(PRINT_DESIGNS.find((d) => d.id === id)?.published, id).toBe(false);
      expect(collectionOf(id), id).toBeUndefined();
    }
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
