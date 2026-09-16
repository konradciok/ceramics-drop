import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import de from '../../messages/de.json';
import en from '../../messages/en.json';
import es from '../../messages/es.json';
import pl from '../../messages/pl.json';
import { PRINT_DESIGNS, registryPrintDesigns } from './prints';
import {
  PRINT_COLLECTIONS,
  UNASSIGNED_COLLECTION,
  groupPrintDesigns,
  loadPrintCollectionDefinitions,
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

type DraftRow = { collection_id: string; revision: number; payload: unknown };

interface FakeSupabaseConfig {
  collections: { id: string; published_revision: number | null }[];
  collection_drafts: DraftRow[];
  collectionsError?: { message: string } | null;
  collectionDraftsError?: { message: string } | null;
}

function fakeSupabase(config: FakeSupabaseConfig): SupabaseClient {
  return {
    from: (table: string) => {
      if (table === 'collections') {
        return {
          select: () => ({
            not: () => ({
              then: (resolve: (v: { data: unknown[]; error: { message: string } | null }) => void) => {
                if (config.collectionsError) {
                  resolve({ data: [], error: config.collectionsError });
                } else {
                  resolve({ data: config.collections.filter((c) => c.published_revision != null), error: null });
                }
              },
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: (_col: string, collectionId: string) => ({
            eq: (_col2: string, revision: number) => ({
              maybeSingle: async () => {
                if (config.collectionDraftsError) {
                  return { data: null, error: config.collectionDraftsError };
                }
                const row = config.collection_drafts.find(
                  (d) => d.collection_id === collectionId && d.revision === revision,
                );
                return { data: row ?? null, error: null };
              },
            }),
          }),
        }),
      };
    },
  } as unknown as SupabaseClient;
}

describe('loadPrintCollectionDefinitions', () => {
  it('returns an empty array when no collections are published', async () => {
    const supabase = fakeSupabase({ collections: [], collection_drafts: [] });
    const result = await loadPrintCollectionDefinitions(supabase);
    expect(result).toEqual([]);
  });

  it('skips unpublished collections entirely', async () => {
    const supabase = fakeSupabase({
      collections: [{ id: 'col_draft1', published_revision: null }],
      collection_drafts: [
        { collection_id: 'col_draft1', revision: 1, payload: { name: 'Draft Only', fields: [] } },
      ],
    });
    const result = await loadPrintCollectionDefinitions(supabase);
    expect(result).toEqual([]);
  });

  it('parses a published collection into slug/name/designIds', async () => {
    const supabase = fakeSupabase({
      collections: [{ id: 'col_abc123', published_revision: 1 }],
      collection_drafts: [
        {
          collection_id: 'col_abc123',
          revision: 1,
          payload: {
            name: 'Ostrea',
            fields: [
              { key: 'slug', label: 'Slug', type: 'text', value: 'ostrea', locale: 'none', sourceLocale: 'none' },
              {
                key: 'products',
                label: 'Produkty i kolejność',
                type: 'productIds',
                value: 'fap001,fap002,fap003',
                locale: 'none',
                sourceLocale: 'none',
              },
            ],
          },
        },
      ],
    });
    const result = await loadPrintCollectionDefinitions(supabase);
    expect(result).toEqual([
      { slug: 'ostrea', name: 'Ostrea', designIds: ['fap001', 'fap002', 'fap003'], prints: [] },
    ]);
  });

  it('falls back to the collection id as slug when no slug field is set', async () => {
    const supabase = fakeSupabase({
      collections: [{ id: 'col_xyz789', published_revision: 1 }],
      collection_drafts: [
        {
          collection_id: 'col_xyz789',
          revision: 1,
          payload: {
            name: 'No Slug Collection',
            fields: [
              {
                key: 'products',
                label: 'Produkty i kolejność',
                type: 'productIds',
                value: 'fap004',
                locale: 'none',
                sourceLocale: 'none',
              },
            ],
          },
        },
      ],
    });
    const result = await loadPrintCollectionDefinitions(supabase);
    expect(result[0].slug).toBe('col_xyz789');
  });

  it('handles an empty products field as zero designIds, not a crash', async () => {
    const supabase = fakeSupabase({
      collections: [{ id: 'col_empty', published_revision: 1 }],
      collection_drafts: [
        {
          collection_id: 'col_empty',
          revision: 1,
          payload: {
            name: 'Empty',
            fields: [
              { key: 'products', label: 'Produkty i kolejność', type: 'productIds', value: '', locale: 'none', sourceLocale: 'none' },
            ],
          },
        },
      ],
    });
    const result = await loadPrintCollectionDefinitions(supabase);
    expect(result[0].designIds).toEqual([]);
  });

  it('throws when the collections query returns an error', async () => {
    const supabase = fakeSupabase({
      collections: [],
      collection_drafts: [],
      collectionsError: { message: 'Database connection failed' },
    });
    await expect(loadPrintCollectionDefinitions(supabase)).rejects.toThrow('Database connection failed');
  });

  it('throws when a collection_drafts query returns an error', async () => {
    const supabase = fakeSupabase({
      collections: [{ id: 'col_abc123', published_revision: 1 }],
      collection_drafts: [],
      collectionDraftsError: { message: 'Failed to fetch draft' },
    });
    await expect(loadPrintCollectionDefinitions(supabase)).rejects.toThrow('Failed to fetch draft');
  });
});
