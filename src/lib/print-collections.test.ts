import { describe, expect, it, vi } from 'vitest';
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
  loadPrintCollectionDefinitionsFromDb,
} from './print-collections';
import type { PrintCollectionDefinition } from './print-curation';
import type { PrintDesign } from './types';

vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn() }));

const { mockGetSupabaseAdmin } = vi.hoisted(() => ({ mockGetSupabaseAdmin: vi.fn() }));
vi.mock('./supabase', () => ({ getSupabaseAdmin: mockGetSupabaseAdmin }));

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

type DraftRow = { collection_id: string; revision: number; payload: unknown; created_at: string };

interface FakeSupabaseConfig {
  collections: { id: string; published_revision: number | null; created_at: string }[];
  collection_drafts: DraftRow[];
  collectionsError?: { message: string } | null;
  collectionDraftsError?: { message: string } | null;
}

/** The payload field every print collection must carry (see
 *  scripts/backfill-fine-art-collections.ts's buildFields). */
const KIND_FIELD = { key: 'kind', label: 'Rodzaj', type: 'text', value: 'print-collection', locale: 'none', sourceLocale: 'none' };

function productsField(value: string) {
  return { key: 'products', label: 'Produkty i kolejność', type: 'productIds', value, locale: 'none', sourceLocale: 'none' };
}

function slugField(value: string) {
  return { key: 'slug', label: 'Slug', type: 'text', value, locale: 'none', sourceLocale: 'none' };
}

/** Fake Supabase client matching loadPrintCollectionDefinitionsFromDb's real
 *  query shape: `collections.select().not().abortSignal()` (now including
 *  each collection's own `created_at`, the ordering key) then a single
 *  batched `collection_drafts.select().in().abortSignal()` — the `.in()`
 *  fetch returns every saved revision for the requested collection ids,
 *  mirroring the real batched query the loader filters/sorts in JS. */
function fakeSupabase(config: FakeSupabaseConfig): SupabaseClient {
  return {
    from: (table: string) => {
      if (table === 'collections') {
        return {
          select: () => ({
            not: () => ({
              abortSignal: () => ({
                then: (resolve: (v: { data: unknown[]; error: { message: string } | null }) => void) => {
                  if (config.collectionsError) {
                    resolve({ data: [], error: config.collectionsError });
                  } else {
                    resolve({ data: config.collections.filter((c) => c.published_revision != null), error: null });
                  }
                },
              }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          in: (_col: string, ids: string[]) => ({
            abortSignal: () => ({
              then: (resolve: (v: { data: unknown[]; error: { message: string } | null }) => void) => {
                if (config.collectionDraftsError) {
                  resolve({ data: [], error: config.collectionDraftsError });
                } else {
                  resolve({
                    data: config.collection_drafts.filter((d) => ids.includes(d.collection_id)),
                    error: null,
                  });
                }
              },
            }),
          }),
        }),
      };
    },
  } as unknown as SupabaseClient;
}

describe('loadPrintCollectionDefinitionsFromDb', () => {
  it('returns an empty array when no collections are published', async () => {
    const supabase = fakeSupabase({ collections: [], collection_drafts: [] });
    const result = await loadPrintCollectionDefinitionsFromDb(supabase);
    expect(result).toEqual([]);
  });

  it('skips unpublished collections entirely', async () => {
    const supabase = fakeSupabase({
      collections: [{ id: 'col_draft1', published_revision: null, created_at: '2026-01-01T00:00:00Z' }],
      collection_drafts: [
        { collection_id: 'col_draft1', revision: 1, created_at: '2026-01-01T00:00:00Z', payload: { name: 'Draft Only', fields: [KIND_FIELD] } },
      ],
    });
    const result = await loadPrintCollectionDefinitionsFromDb(supabase);
    expect(result).toEqual([]);
  });

  it('parses a published collection into slug/name/designIds', async () => {
    const supabase = fakeSupabase({
      collections: [{ id: 'col_abc123', published_revision: 1, created_at: '2026-01-01T00:00:00Z' }],
      collection_drafts: [
        {
          collection_id: 'col_abc123',
          revision: 1,
          created_at: '2026-01-01T00:00:00Z',
          payload: {
            name: 'Ostrea',
            fields: [KIND_FIELD, slugField('ostrea'), productsField('fap001,fap002,fap003')],
          },
        },
      ],
    });
    const result = await loadPrintCollectionDefinitionsFromDb(supabase);
    expect(result).toEqual([
      { slug: 'ostrea', name: 'Ostrea', designIds: ['fap001', 'fap002', 'fap003'], prints: [] },
    ]);
  });

  it('falls back to the collection id as slug when no slug field is set', async () => {
    const supabase = fakeSupabase({
      collections: [{ id: 'col_xyz789', published_revision: 1, created_at: '2026-01-01T00:00:00Z' }],
      collection_drafts: [
        {
          collection_id: 'col_xyz789',
          revision: 1,
          created_at: '2026-01-01T00:00:00Z',
          payload: { name: 'No Slug Collection', fields: [KIND_FIELD, productsField('fap004')] },
        },
      ],
    });
    const result = await loadPrintCollectionDefinitionsFromDb(supabase);
    expect(result[0].slug).toBe('col_xyz789');
  });

  it('handles an empty products field as zero designIds, not a crash', async () => {
    const supabase = fakeSupabase({
      collections: [{ id: 'col_empty', published_revision: 1, created_at: '2026-01-01T00:00:00Z' }],
      collection_drafts: [
        {
          collection_id: 'col_empty',
          revision: 1,
          created_at: '2026-01-01T00:00:00Z',
          payload: { name: 'Empty', fields: [KIND_FIELD, productsField('')] },
        },
      ],
    });
    const result = await loadPrintCollectionDefinitionsFromDb(supabase);
    expect(result[0].designIds).toEqual([]);
  });

  it('throws when the collections query returns an error', async () => {
    const supabase = fakeSupabase({
      collections: [],
      collection_drafts: [],
      collectionsError: { message: 'Database connection failed' },
    });
    await expect(loadPrintCollectionDefinitionsFromDb(supabase)).rejects.toThrow('Database connection failed');
  });

  it('throws when the batched collection_drafts query returns an error', async () => {
    const supabase = fakeSupabase({
      collections: [{ id: 'col_abc123', published_revision: 1, created_at: '2026-01-01T00:00:00Z' }],
      collection_drafts: [],
      collectionDraftsError: { message: 'Failed to fetch drafts' },
    });
    await expect(loadPrintCollectionDefinitionsFromDb(supabase)).rejects.toThrow('Failed to fetch drafts');
  });

  it('picks only the draft revision matching published_revision, ignoring other saved revisions returned by the batched fetch', async () => {
    const supabase = fakeSupabase({
      collections: [{ id: 'col_x', published_revision: 2, created_at: '2026-01-01T00:00:00Z' }],
      collection_drafts: [
        { collection_id: 'col_x', revision: 1, created_at: '2026-01-01T00:00:00Z', payload: { name: 'Old Draft', fields: [KIND_FIELD] } },
        { collection_id: 'col_x', revision: 2, created_at: '2026-01-02T00:00:00Z', payload: { name: 'Published', fields: [KIND_FIELD] } },
      ],
    });
    const result = await loadPrintCollectionDefinitionsFromDb(supabase);
    expect(result).toEqual([{ slug: 'col_x', name: 'Published', designIds: [], prints: [] }]);
  });

  it('orders published collections by the collection\'s own created_at, oldest first, regardless of row order', async () => {
    const supabase = fakeSupabase({
      collections: [
        { id: 'col_b', published_revision: 1, created_at: '2026-02-01T00:00:00Z' },
        { id: 'col_a', published_revision: 1, created_at: '2026-01-01T00:00:00Z' },
      ],
      collection_drafts: [
        { collection_id: 'col_b', revision: 1, created_at: '2026-02-01T00:00:00Z', payload: { name: 'B', fields: [KIND_FIELD] } },
        { collection_id: 'col_a', revision: 1, created_at: '2026-01-01T00:00:00Z', payload: { name: 'A', fields: [KIND_FIELD] } },
      ],
    });
    const result = await loadPrintCollectionDefinitionsFromDb(supabase);
    expect(result.map((d) => d.name)).toEqual(['A', 'B']);
  });

  it('orders by the collection\'s created_at, not the published draft\'s — a republish must not reshuffle the storefront', async () => {
    // col_a was created before col_b, but col_a's *published* revision
    // (2, matching published_revision) was drafted later than col_b — the
    // kind of thing that happens the first time someone edits and
    // republishes col_a through the CMS. save_collection_draft stamps that
    // new revision with a fresh created_at, so ordering by the draft's
    // timestamp would move col_a's section after col_b's. The storefront
    // order must still follow collection creation order.
    const supabase = fakeSupabase({
      collections: [
        { id: 'col_a', published_revision: 2, created_at: '2026-01-01T00:00:00Z' },
        { id: 'col_b', published_revision: 1, created_at: '2026-01-02T00:00:00Z' },
      ],
      collection_drafts: [
        { collection_id: 'col_a', revision: 1, created_at: '2026-01-01T00:00:00Z', payload: { name: 'A rev1', fields: [KIND_FIELD] } },
        { collection_id: 'col_a', revision: 2, created_at: '2026-03-01T00:00:00Z', payload: { name: 'A', fields: [KIND_FIELD] } },
        { collection_id: 'col_b', revision: 1, created_at: '2026-01-02T00:00:00Z', payload: { name: 'B', fields: [KIND_FIELD] } },
      ],
    });
    const result = await loadPrintCollectionDefinitionsFromDb(supabase);
    expect(result.map((d) => d.name)).toEqual(['A', 'B']);
  });

  it('breaks a tie between two collections with an identical created_at by collection id, for deterministic ordering', async () => {
    const supabase = fakeSupabase({
      collections: [
        { id: 'col_z', published_revision: 1, created_at: '2026-01-01T00:00:00Z' },
        { id: 'col_a', published_revision: 1, created_at: '2026-01-01T00:00:00Z' },
      ],
      collection_drafts: [
        { collection_id: 'col_z', revision: 1, created_at: '2026-01-01T00:00:00Z', payload: { name: 'Z', fields: [KIND_FIELD] } },
        { collection_id: 'col_a', revision: 1, created_at: '2026-01-01T00:00:00Z', payload: { name: 'A', fields: [KIND_FIELD] } },
      ],
    });
    const result = await loadPrintCollectionDefinitionsFromDb(supabase);
    expect(result.map((d) => d.name)).toEqual(['A', 'Z']);
  });

  it('excludes a published collection with no kind field (not a print collection)', async () => {
    const supabase = fakeSupabase({
      collections: [{ id: 'col_generic', published_revision: 1, created_at: '2026-01-01T00:00:00Z' }],
      collection_drafts: [
        { collection_id: 'col_generic', revision: 1, created_at: '2026-01-01T00:00:00Z', payload: { name: 'Some Ceramics Collection', fields: [] } },
      ],
    });
    const result = await loadPrintCollectionDefinitionsFromDb(supabase);
    expect(result).toEqual([]);
  });

  it('excludes a published collection whose kind field has a different value', async () => {
    const supabase = fakeSupabase({
      collections: [{ id: 'col_other_kind', published_revision: 1, created_at: '2026-01-01T00:00:00Z' }],
      collection_drafts: [
        {
          collection_id: 'col_other_kind',
          revision: 1,
          created_at: '2026-01-01T00:00:00Z',
          payload: { name: 'Ceramics', fields: [{ key: 'kind', label: 'Rodzaj', type: 'text', value: 'ceramic-collection', locale: 'none', sourceLocale: 'none' }] },
        },
      ],
    });
    const result = await loadPrintCollectionDefinitionsFromDb(supabase);
    expect(result).toEqual([]);
  });

  it.each([
    ['missing entirely', {}],
    ['not a string', { name: 123 }],
  ])('skips a collection whose payload name is %s, rather than crashing', async (_label, payloadOverrides) => {
    const supabase = fakeSupabase({
      collections: [{ id: 'col_bad_name', published_revision: 1, created_at: '2026-01-01T00:00:00Z' }],
      collection_drafts: [
        { collection_id: 'col_bad_name', revision: 1, created_at: '2026-01-01T00:00:00Z', payload: { ...payloadOverrides, fields: [KIND_FIELD] } },
      ],
    });
    const result = await loadPrintCollectionDefinitionsFromDb(supabase);
    expect(result).toEqual([]);
  });

  it('de-dupes design ids across collections — the earlier collection (by created_at order) wins', async () => {
    const supabase = fakeSupabase({
      collections: [
        { id: 'col_first', published_revision: 1, created_at: '2026-01-01T00:00:00Z' },
        { id: 'col_second', published_revision: 1, created_at: '2026-01-02T00:00:00Z' },
      ],
      collection_drafts: [
        { collection_id: 'col_first', revision: 1, created_at: '2026-01-01T00:00:00Z', payload: { name: 'First', fields: [KIND_FIELD, productsField('fap001,fap002')] } },
        { collection_id: 'col_second', revision: 1, created_at: '2026-01-02T00:00:00Z', payload: { name: 'Second', fields: [KIND_FIELD, productsField('fap002,fap003')] } },
      ],
    });
    const result = await loadPrintCollectionDefinitionsFromDb(supabase);
    expect(result.map((d) => d.designIds)).toEqual([['fap001', 'fap002'], ['fap003']]);
  });

  it('de-dupes colliding manually-set slugs by appending a numeric suffix, logging a warning', async () => {
    const supabase = fakeSupabase({
      collections: [
        { id: 'col_first', published_revision: 1, created_at: '2026-01-01T00:00:00Z' },
        { id: 'col_second', published_revision: 1, created_at: '2026-01-02T00:00:00Z' },
        { id: 'col_third', published_revision: 1, created_at: '2026-01-03T00:00:00Z' },
      ],
      collection_drafts: [
        { collection_id: 'col_first', revision: 1, created_at: '2026-01-01T00:00:00Z', payload: { name: 'First', fields: [KIND_FIELD, slugField('same')] } },
        { collection_id: 'col_second', revision: 1, created_at: '2026-01-02T00:00:00Z', payload: { name: 'Second', fields: [KIND_FIELD, slugField('same')] } },
        { collection_id: 'col_third', revision: 1, created_at: '2026-01-03T00:00:00Z', payload: { name: 'Third', fields: [KIND_FIELD, slugField('same')] } },
      ],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await loadPrintCollectionDefinitionsFromDb(supabase);
    expect(result.map((d) => d.slug)).toEqual(['same', 'same-2', 'same-3']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('loadPrintCollectionDefinitions (request-cached, fallback-on-failure)', () => {
  it('returns real DB-sourced definitions when the read succeeds', async () => {
    mockGetSupabaseAdmin.mockReturnValue(
      fakeSupabase({
        collections: [{ id: 'col_abc123', published_revision: 1, created_at: '2026-01-01T00:00:00Z' }],
        collection_drafts: [
          {
            collection_id: 'col_abc123',
            revision: 1,
            created_at: '2026-01-01T00:00:00Z',
            payload: { name: 'Ostrea', fields: [KIND_FIELD, productsField('fap001')] },
          },
        ],
      }),
    );
    const result = await loadPrintCollectionDefinitions();
    expect(result).toEqual([{ slug: 'col_abc123', name: 'Ostrea', designIds: ['fap001'], prints: [] }]);
  });

  it('falls back to the static PRINT_COLLECTIONS array when getSupabaseAdmin() throws', async () => {
    mockGetSupabaseAdmin.mockImplementation(() => {
      throw new Error('offline');
    });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await loadPrintCollectionDefinitions();
    expect(result).toEqual(PRINT_COLLECTIONS);
    errorLog.mockRestore();
  });

  it('falls back to the static PRINT_COLLECTIONS array when the underlying query errors', async () => {
    mockGetSupabaseAdmin.mockReturnValue(
      fakeSupabase({ collections: [], collection_drafts: [], collectionsError: { message: 'Database connection failed' } }),
    );
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await loadPrintCollectionDefinitions();
    expect(result).toEqual(PRINT_COLLECTIONS);
    errorLog.mockRestore();
  });
});

describe('groupPrintDesigns with an explicit definitions array', () => {
  it('groups by the passed-in definitions instead of PRINT_COLLECTIONS', () => {
    const customDefinitions: PrintCollectionDefinition[] = [
      { slug: 'custom', name: 'Custom', designIds: ['fap001'], prints: [] },
    ];
    const designs = [{ id: 'fap001' } as PrintDesign, { id: 'fap002' } as PrintDesign];
    const groups = groupPrintDesigns(designs, customDefinitions);
    expect(groups).toEqual([
      { slug: 'custom', name: 'Custom', designs: [designs[0]] },
      { slug: 'inne', name: undefined, designs: [designs[1]] },
    ]);
  });
});
