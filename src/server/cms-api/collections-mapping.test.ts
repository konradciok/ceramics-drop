import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadCollectionResponse, loadCollectionResponses } from './collections-mapping';

function makeCollectionsTable(data: unknown[]) {
  const builder: Record<string, unknown> = {};
  const self = () => builder;
  builder.select = self;
  builder.in = self;
  builder.then = (resolve: (v: { data: unknown[]; error: null }) => void) => resolve({ data, error: null });
  return builder;
}

type DraftRow = { collection_id: string; revision: number; payload: unknown };

// Mirrors the real chain (`select().eq('collection_id', id).order().limit(1).maybeSingle()`)
// and filters by the id passed to `.eq()`, since loadCollectionResponses now
// queries each collection's latest draft individually rather than in one
// `.in()` batch (see collections-mapping.ts for why).
function makeDraftsTable(data: DraftRow[]) {
  return {
    select: () => ({
      eq: (_column: string, id: string) => ({
        order: () => ({
          limit: () => ({
            maybeSingle: async () => {
              const rows = data.filter((row) => row.collection_id === id).sort((a, b) => b.revision - a.revision);
              return { data: rows[0] ?? null, error: null };
            },
          }),
        }),
      }),
    }),
  };
}

function fakeSupabase(tables: { collections: unknown[]; collection_drafts: DraftRow[] }): SupabaseClient {
  return {
    from: (table: string) => (table === 'collections' ? makeCollectionsTable(tables.collections) : makeDraftsTable(tables.collection_drafts)),
  } as unknown as SupabaseClient;
}

describe('loadCollectionResponses', () => {
  it('returns an empty map without querying supabase for an empty id list', async () => {
    let called = false;
    const supabase = {
      from: () => {
        called = true;
        return makeCollectionsTable([]);
      },
    } as unknown as SupabaseClient;
    const result = await loadCollectionResponses(supabase, []);
    expect(result.size).toBe(0);
    expect(called).toBe(false);
  });

  it('uses the latest collection_drafts payload (highest revision) when several exist', async () => {
    const supabase = fakeSupabase({
      collections: [{ id: 'col_1', published_revision: null }],
      collection_drafts: [
        { collection_id: 'col_1', revision: 3, payload: { name: 'Newest', fields: [] } },
        { collection_id: 'col_1', revision: 2, payload: { name: 'Middle', fields: [] } },
        { collection_id: 'col_1', revision: 1, payload: { name: 'Oldest', fields: [] } },
      ],
    });
    const result = await loadCollectionResponses(supabase, ['col_1']);
    const collection = result.get('col_1')!;
    expect(collection.revision).toBe(3);
    expect(collection.name).toBe('Newest');
  });

  it('maps payload.name/payload.fields onto the response verbatim', async () => {
    const field = { key: 'headline', label: 'Headline', type: 'text', value: 'Wiosna', locale: 'pl', sourceLocale: 'pl' };
    const supabase = fakeSupabase({
      collections: [{ id: 'col_1', published_revision: 1 }],
      collection_drafts: [{ collection_id: 'col_1', revision: 1, payload: { name: 'Wiosenna kolekcja', fields: [field] } }],
    });
    const result = await loadCollectionResponses(supabase, ['col_1']);
    const collection = result.get('col_1')!;
    expect(collection.id).toBe('col_1');
    expect(collection.kind).toBe('collections');
    expect(collection.name).toBe('Wiosenna kolekcja');
    expect(collection.fields).toEqual([field]);
  });

  it('reflects collections.published_revision independently of the latest (ahead) draft revision', async () => {
    const supabase = fakeSupabase({
      collections: [{ id: 'col_1', published_revision: 2 }],
      collection_drafts: [
        { collection_id: 'col_1', revision: 3, payload: { name: 'Draft in progress', fields: [] } },
        { collection_id: 'col_1', revision: 2, payload: { name: 'Published version', fields: [] } },
        { collection_id: 'col_1', revision: 1, payload: { name: 'First', fields: [] } },
      ],
    });
    const result = await loadCollectionResponses(supabase, ['col_1']);
    const collection = result.get('col_1')!;
    // revision/name/fields show the latest draft (revision 3) — publish state
    // is tracked separately via publishedRevision, which stays at 2.
    expect(collection.revision).toBe(3);
    expect(collection.name).toBe('Draft in progress');
    expect(collection.publishedRevision).toBe(2);
  });

  it('leaves publishedRevision null for a never-published collection', async () => {
    const supabase = fakeSupabase({
      collections: [{ id: 'col_1', published_revision: null }],
      collection_drafts: [{ collection_id: 'col_1', revision: 1, payload: { name: 'Draft only', fields: [] } }],
    });
    const result = await loadCollectionResponses(supabase, ['col_1']);
    expect(result.get('col_1')!.publishedRevision).toBeNull();
  });

  it('batches multiple ids into one response map, each keeping its own latest draft', async () => {
    const supabase = fakeSupabase({
      collections: [
        { id: 'col_1', published_revision: null },
        { id: 'col_2', published_revision: 1 },
      ],
      collection_drafts: [
        { collection_id: 'col_1', revision: 1, payload: { name: 'First collection', fields: [] } },
        { collection_id: 'col_2', revision: 2, payload: { name: 'Second collection v2', fields: [] } },
        { collection_id: 'col_2', revision: 1, payload: { name: 'Second collection v1', fields: [] } },
      ],
    });
    const result = await loadCollectionResponses(supabase, ['col_1', 'col_2']);
    expect(result.size).toBe(2);
    expect(result.get('col_1')!.name).toBe('First collection');
    expect(result.get('col_2')!.name).toBe('Second collection v2');
    expect(result.get('col_2')!.revision).toBe(2);
  });

  it('falls back to an empty revision-0 draft for a collections row with no matching collection_drafts row, and logs a warning so the anomaly is discoverable', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const supabase = fakeSupabase({
        collections: [{ id: 'col_orphan', published_revision: null }],
        collection_drafts: [],
      });
      const result = await loadCollectionResponses(supabase, ['col_orphan']);
      const collection = result.get('col_orphan')!;
      expect(collection.revision).toBe(0);
      expect(collection.name).toBe('');
      expect(collection.fields).toEqual([]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('col_orphan');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does not log a warning for a collection that has a matching draft', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const supabase = fakeSupabase({
        collections: [{ id: 'col_1', published_revision: null }],
        collection_drafts: [{ collection_id: 'col_1', revision: 1, payload: { name: 'Fine', fields: [] } }],
      });
      await loadCollectionResponses(supabase, ['col_1']);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('propagates a collections-query error instead of swallowing it', async () => {
    const supabase = {
      from: (table: string) => {
        if (table === 'collections') {
          const builder: Record<string, unknown> = {};
          const self = () => builder;
          builder.select = self;
          builder.in = self;
          builder.then = (resolve: (v: { data: null; error: unknown }) => void) => resolve({ data: null, error: new Error('boom') });
          return builder;
        }
        return makeDraftsTable([]);
      },
    } as unknown as SupabaseClient;
    await expect(loadCollectionResponses(supabase, ['col_1'])).rejects.toThrow('boom');
  });

  it('propagates a per-collection draft-query error instead of swallowing it', async () => {
    const supabase = {
      from: (table: string) => {
        if (table === 'collections') return makeCollectionsTable([{ id: 'col_1', published_revision: null }]);
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: null, error: new Error('draft query boom') }),
                }),
              }),
            }),
          }),
        };
      },
    } as unknown as SupabaseClient;
    await expect(loadCollectionResponses(supabase, ['col_1'])).rejects.toThrow('draft query boom');
  });
});

describe('loadCollectionResponse', () => {
  it('returns null when the collection does not exist', async () => {
    const supabase = fakeSupabase({ collections: [], collection_drafts: [] });
    const result = await loadCollectionResponse(supabase, 'col_missing');
    expect(result).toBeNull();
  });

  it('returns the single collection response when it exists', async () => {
    const supabase = fakeSupabase({
      collections: [{ id: 'col_1', published_revision: null }],
      collection_drafts: [{ collection_id: 'col_1', revision: 1, payload: { name: 'Solo', fields: [] } }],
    });
    const result = await loadCollectionResponse(supabase, 'col_1');
    expect(result?.name).toBe('Solo');
  });
});
