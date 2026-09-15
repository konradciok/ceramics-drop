import type { SupabaseClient } from '@supabase/supabase-js';
import type { CollectionResponse, Field } from './types';

type CollectionRow = {
  id: string;
  published_revision: number | null;
};

type CollectionDraftPayload = { name: string; fields: Field[] };

type LatestCollectionDraft = { revision: number; payload: CollectionDraftPayload };

export async function loadCollectionResponses(
  supabase: SupabaseClient,
  collectionIds: string[],
): Promise<Map<string, CollectionResponse>> {
  if (collectionIds.length === 0) return new Map();

  // Fetching every requested collection's drafts with one `.in()` + a global
  // `order('revision')` would rely on PostgREST's implicit max_rows cap
  // (1000) to not silently truncate — and truncation drops the *lowest*
  // revision rows across all requested collections combined, which can
  // discard an entire low-numbered collection's only draft while collections
  // with heavily-edited (high-revision) drafts survive. Querying the latest
  // draft per collection individually (using the covering
  // `collection_drafts_collection_idx (collection_id, revision desc)` index)
  // is correct at any scale instead of depending on that cap.
  const [collectionsRes, draftResults] = await Promise.all([
    supabase.from('collections').select('id, published_revision').in('id', collectionIds),
    Promise.all(
      collectionIds.map((id) =>
        supabase
          .from('collection_drafts')
          .select('revision, payload')
          .eq('collection_id', id)
          .order('revision', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ),
    ),
  ]);

  if (collectionsRes.error) throw collectionsRes.error;
  for (const res of draftResults) {
    if (res.error) throw res.error;
  }

  const collections = (collectionsRes.data ?? []) as CollectionRow[];

  const latestDraftByCollection = new Map<string, LatestCollectionDraft>();
  draftResults.forEach((res, index) => {
    const row = res.data as { revision: number; payload: CollectionDraftPayload } | null;
    if (row) {
      latestDraftByCollection.set(collectionIds[index], { revision: row.revision, payload: row.payload });
    }
  });

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
    // instead of a 500 that hides which collection is broken. Log it (same
    // `[cms-api]` prefix convention as request-handler.ts's unhandled-error
    // logging) so this anomaly is at least discoverable if it ever fires —
    // otherwise the collection just silently looks empty forever.
    if (!draftEntry) {
      console.warn(`[cms-api] collection ${collection.id} has no collection_drafts row — falling back to an empty revision-0 draft`);
    }
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
