import type { SupabaseClient } from '@supabase/supabase-js';
import type { CollectionResponse, Field } from './types';

type CollectionRow = {
  id: string;
  published_revision: number | null;
};

type CollectionDraftPayload = { name: string; fields: Field[] };

type CollectionDraftRow = {
  collection_id: string;
  revision: number;
  payload: CollectionDraftPayload;
};

export async function loadCollectionResponses(
  supabase: SupabaseClient,
  collectionIds: string[],
): Promise<Map<string, CollectionResponse>> {
  if (collectionIds.length === 0) return new Map();

  const [collectionsRes, draftsRes] = await Promise.all([
    supabase.from('collections').select('id, published_revision').in('id', collectionIds),
    supabase
      .from('collection_drafts')
      .select('collection_id, revision, payload')
      .in('collection_id', collectionIds)
      .order('revision', { ascending: false }),
  ]);

  for (const res of [collectionsRes, draftsRes]) {
    if (res.error) throw res.error;
  }

  const collections = (collectionsRes.data ?? []) as CollectionRow[];

  // draftsRes is ordered by revision desc, so the first row seen per
  // collection_id is its latest draft — the "current draft" that save/get
  // should show, which may be ahead of collections.published_revision. Same
  // "first wins" convention mapping.ts's loadProductResponses uses for
  // product_drafts.
  const latestDraftByCollection = new Map<string, { revision: number; payload: CollectionDraftPayload }>();
  for (const row of (draftsRes.data ?? []) as CollectionDraftRow[]) {
    if (!latestDraftByCollection.has(row.collection_id)) {
      latestDraftByCollection.set(row.collection_id, { revision: row.revision, payload: row.payload });
    }
  }

  const result = new Map<string, CollectionResponse>();
  for (const collection of collections) {
    const draftEntry = latestDraftByCollection.get(collection.id);
    // create_collection_with_draft (Task 1's migration) always inserts
    // collections + its first collection_drafts row (revision 1) in the same
    // transaction, so every collections row is expected to have a matching
    // draft — unlike products, which has legacy rows that predate
    // product_drafts entirely. A missing draftEntry here would mean data
    // corruption, not a normal state; fall back to an empty revision-0 draft
    // rather than throwing, so a corrupt row still surfaces as a response
    // instead of a 500 that hides which collection is broken.
    const revision = draftEntry?.revision ?? 0;
    const name = draftEntry?.payload.name ?? '';
    const fields = draftEntry?.payload.fields ?? [];

    result.set(collection.id, {
      id: collection.id,
      kind: 'collections',
      name,
      revision,
      // publishedRevision reflects collections.published_revision directly
      // (nullable) — collections have no status column, so there is no
      // "active implies revision 0" synthesis like products' publishedRevision.
      publishedRevision: collection.published_revision,
      fields,
    });
  }
  return result;
}

export async function loadCollectionResponse(
  supabase: SupabaseClient,
  collectionId: string,
): Promise<CollectionResponse | null> {
  const map = await loadCollectionResponses(supabase, [collectionId]);
  return map.get(collectionId) ?? null;
}
