import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadPrintCollectionDefinitions } from './print-collections';

type DraftRow = { collection_id: string; revision: number; payload: unknown };

function fakeSupabase(rows: {
  collections: { id: string; published_revision: number | null }[];
  collection_drafts: DraftRow[];
}): SupabaseClient {
  return {
    from: (table: string) => {
      if (table === 'collections') {
        return {
          select: () => ({
            not: () => ({
              then: (resolve: (v: { data: unknown[]; error: null }) => void) =>
                resolve({ data: rows.collections.filter((c) => c.published_revision != null), error: null }),
            }),
          }),
        };
      }
      return {
        select: () => ({
          eq: (_col: string, collectionId: string) => ({
            eq: (_col2: string, revision: number) => ({
              maybeSingle: async () => {
                const row = rows.collection_drafts.find(
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
});
