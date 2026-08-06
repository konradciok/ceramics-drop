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
    expect(groups.map((g) => g.slug)).toEqual([
      ...PRINT_COLLECTIONS.map((c) => c.slug),
      UNASSIGNED_COLLECTION,
    ]);
    const flat = groups.flatMap((g) => g.designs.map((d) => d.id));
    expect(new Set(flat).size).toBe(flat.length);
    expect(flat.sort()).toEqual(published.map((d) => d.id).sort());
  });

  it('legacy fap01–fap03 land in the fallback bucket', () => {
    const groups = groupPrintDesigns(published);
    const inne = groups.find((g) => g.slug === UNASSIGNED_COLLECTION);
    expect(inne?.designs.map((d) => d.id)).toEqual(['fap01', 'fap02', 'fap03']);
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
