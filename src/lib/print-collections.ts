/* ============================================================
   Print collections — visually curated groups for /fine-art-prints.
   ------------------------------------------------------------
   Membership is keyed by design id, NOT stored on PrintDesign: under
   CATALOG_SOURCE=db the catalog mapper rebuilds designs field-by-field
   from DB rows, so a registry-only field would be silently dropped
   (and would break the catalog-parity round-trip). Grouping whatever
   getPrintDesigns() returns keeps code and db mode identical.
   Curated collections come directly from the print curation map so their
   names, membership, and display order have one source of truth. Anything
   unknown to that map (for example a DB-created design) remains safely in
   the localized fallback bucket.
   ============================================================ */
import { cache } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { PRINT_COLLECTION_DEFINITIONS } from './print-curation';
import type { PrintCollectionDefinition } from './print-curation';
import type { PrintDesign } from './types';
import { getSupabaseAdmin } from './supabase';
import { readWithFallback, supabaseTimeout } from './supabase-timeout';

export type PrintCollectionSlug = string;

/** Fallback bucket for designs not listed in any collection, including
    unexpected DB-created designs. Permanent slug. */
export const UNASSIGNED_COLLECTION: PrintCollectionSlug = 'inne';

/** Ordered collections; designIds sets the display order within each. */
export const PRINT_COLLECTIONS = PRINT_COLLECTION_DEFINITIONS;

/** Group designs (as returned by getPrintDesigns()) into display order:
    collection order, designIds order within, then the 'inne' fallback
    bucket (in input order) for anything unassigned. Empty groups are
    dropped — an unpublished member simply doesn't render. */
export function groupPrintDesigns(
  designs: PrintDesign[],
  definitions: PrintCollectionDefinition[] = PRINT_COLLECTIONS,
): { slug: PrintCollectionSlug; name?: string; designs: PrintDesign[] }[] {
  const byId = new Map(designs.map((d) => [d.id, d]));
  const collectionById = new Map<string, PrintCollectionSlug>(
    definitions.flatMap((c) => c.designIds.map((id) => [id, c.slug] as const)),
  );
  const groups: { slug: PrintCollectionSlug; name?: string; designs: PrintDesign[] }[] = definitions.map(({ slug, name, designIds }) => ({
    slug,
    name,
    designs: designIds.flatMap((id) => byId.get(id) ?? []),
  }));
  const rest = designs.filter((d) => !collectionById.has(d.id));
  groups.push({ slug: UNASSIGNED_COLLECTION, name: undefined, designs: rest });
  return groups.filter((g) => g.designs.length > 0);
}

type CollectionField = {
  key: string;
  value: string;
};

/** Payload field convention (see scripts/backfill-fine-art-collections.ts's
 *  buildFields): only a collection explicitly tagged with this scopes into
 *  the fine-art-print storefront sections. A collection created via the
 *  CMS's generic "+ Nowa kolekcja" button has no `kind` field and is safely
 *  excluded by default. */
const PRINT_COLLECTION_KIND = 'print-collection';

/**
 * Raw DB read behind `loadPrintCollectionDefinitions` below — published
 * collections only, never a draft, scoped to `kind === 'print-collection'`.
 * Exported separately (rather than only via the cached/fallback wrapper) so
 * tests can exercise the query shape and parsing logic directly against a
 * fake Supabase client. App code should call `loadPrintCollectionDefinitions()`
 * instead — this one throws on any Supabase error, same as every other
 * low-level repository reader in this codebase.
 *
 * `prints` is always returned empty: nothing in this codebase reads it
 * (only `.designIds` and `.name`/`.slug` are used by any current or Plan-1
 * caller — see print-curation.ts's own PRINT_COLLECTION_DEFINITIONS
 * construction, where `prints` mirrors curation-map metadata that has no DB
 * equivalent and no consumer).
 */
export async function loadPrintCollectionDefinitionsFromDb(
  supabase: SupabaseClient,
): Promise<PrintCollectionDefinition[]> {
  const { data: collections, error: collectionsError } = await supabase
    .from('collections')
    .select('id, published_revision, created_at')
    .not('published_revision', 'is', null)
    .abortSignal(supabaseTimeout());
  if (collectionsError) throw collectionsError;

  const rows = (collections ?? []) as { id: string; published_revision: number; created_at: string }[];
  if (rows.length === 0) return [];

  const publishedRevisionById = new Map(rows.map((r) => [r.id, r.published_revision]));
  // The collection's own created_at — set once, at creation, and never
  // touched again by save_collection_draft/publish_collection_revision.
  // Used as the ordering key below instead of the published draft's own
  // created_at (see the ordering comment further down for why).
  const collectionCreatedAtById = new Map(rows.map((r) => [r.id, r.created_at]));
  const ids = rows.map((r) => r.id);

  // One batched fetch instead of one query per collection (N+1): a single
  // collection can have many saved draft revisions, so this pulls every
  // revision for every published collection and the loop below picks out
  // just the one matching each collection's published_revision — a single
  // `.eq('revision', X)` can't work here since different collections have
  // different published_revision values.
  const { data: drafts, error: draftsError } = await supabase
    .from('collection_drafts')
    .select('collection_id, revision, payload, created_at')
    .in('collection_id', ids)
    .abortSignal(supabaseTimeout());
  if (draftsError) throw draftsError;

  type DraftRow = { collection_id: string; revision: number; payload: unknown; created_at: string };
  const draftRows = (drafts ?? []) as DraftRow[];

  // Exactly the published draft per collection, ordered oldest-collection-
  // created-first. Postgres without ORDER BY returns heap order, which can
  // silently change on the next UPDATE (publish_collection_revision UPDATEs
  // collections.published_revision) — this ordering is what fixes the
  // on-page section order (groupPrintDesigns maps over the returned array in
  // sequence) so a republish can never reshuffle the storefront.
  //
  // Deliberately keyed on the *collection's* created_at, not the draft's:
  // save_collection_draft stamps every new revision with a fresh created_at,
  // so sorting by the draft's timestamp would move a collection's section
  // the moment someone edits and republishes it (its published draft row
  // would then be the newest one). collections.created_at is set once at
  // creation and is untouched by edits/republishes, so it's stable across
  // the collection's whole lifetime. The collection id is a deterministic
  // tie-breaker for the (currently impossible, but not DB-enforced) case of
  // two collections sharing an identical created_at.
  const publishedDrafts = draftRows
    .filter((d) => d.revision === publishedRevisionById.get(d.collection_id))
    .sort((a, b) => {
      const aCreatedAt = collectionCreatedAtById.get(a.collection_id) ?? '';
      const bCreatedAt = collectionCreatedAtById.get(b.collection_id) ?? '';
      return aCreatedAt.localeCompare(bCreatedAt) || a.collection_id.localeCompare(b.collection_id);
    });

  const definitions: PrintCollectionDefinition[] = [];
  const seenDesignIds = new Set<string>();
  const seenSlugCounts = new Map<string, number>();

  for (const draft of publishedDrafts) {
    const payload = draft.payload as { name?: unknown; fields?: CollectionField[] };
    // Guard against a missing/malformed name rather than producing `name:
    // undefined` — treat it like a missing draft and skip the collection.
    if (typeof payload?.name !== 'string') continue;

    const fields = payload.fields ?? [];
    const kindField = fields.find((f) => f.key === 'kind');
    if (kindField?.value !== PRINT_COLLECTION_KIND) continue;

    const slugField = fields.find((f) => f.key === 'slug');
    const productsField = fields.find((f) => f.key === 'products');
    const rawDesignIds = productsField?.value
      ? productsField.value.split(',').map((id) => id.trim()).filter((id) => id.length > 0)
      : [];

    // De-dupe product ids across collections, first-collection-wins — matches
    // printDisplayName's own "first match in array order wins" resolution.
    const designIds = rawDesignIds.filter((id) => {
      if (seenDesignIds.has(id)) return false;
      seenDesignIds.add(id);
      return true;
    });

    // De-dupe colliding slugs (two collections manually set the same slug)
    // by appending a numeric suffix, logging a warning.
    const baseSlug = slugField?.value || draft.collection_id;
    const priorCount = seenSlugCounts.get(baseSlug) ?? 0;
    seenSlugCounts.set(baseSlug, priorCount + 1);
    const slug = priorCount === 0 ? baseSlug : `${baseSlug}-${priorCount + 1}`;
    if (priorCount > 0) {
      console.warn(`[print-collections] duplicate slug "${baseSlug}" — renamed to "${slug}"`);
    }

    definitions.push({ slug, name: payload.name, designIds, prints: [] });
  }

  return definitions;
}

/**
 * Loads the real, CMS-managed fine-art-print collections for the storefront.
 * Request-scoped memoized via React's `cache()` (same pattern as
 * getCeramicSaleState/fetchPieceState) since every render path that needs
 * this — /sklep's generateMetadata + Page, the print PDP's generateMetadata
 * + Page, and the homepage — calls it independently; wrapping the DB read
 * itself (not a value depending on caller-supplied arguments) is what lets
 * cache() actually dedupe across all of them within one request.
 *
 * Never throws and never hangs past the Supabase timeout: any failure
 * degrades to the static `PRINT_COLLECTIONS` array (same shape
 * `printDisplayName` already defaults to), preserving pre-migration
 * rendering exactly — this migration's stated goal.
 */
export const loadPrintCollectionDefinitions = cache(
  async (): Promise<PrintCollectionDefinition[]> =>
    readWithFallback(
      'printCollectionDefinitions',
      () => loadPrintCollectionDefinitionsFromDb(getSupabaseAdmin()),
      PRINT_COLLECTIONS,
    ),
);
