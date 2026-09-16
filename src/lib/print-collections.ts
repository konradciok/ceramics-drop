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
import type { SupabaseClient } from '@supabase/supabase-js';
import { PRINT_COLLECTION_DEFINITIONS } from './print-curation';
import type { PrintCollectionDefinition } from './print-curation';
import type { PrintDesign } from './types';

export type PrintCollectionSlug = string;

/** Fallback bucket for designs not listed in any collection, including
    unexpected DB-created designs. Permanent slug. */
export const UNASSIGNED_COLLECTION: PrintCollectionSlug = 'inne';

/** Ordered collections; designIds sets the display order within each. */
export const PRINT_COLLECTIONS = PRINT_COLLECTION_DEFINITIONS;

const COLLECTION_BY_ID: ReadonlyMap<string, PrintCollectionSlug> = new Map(
  PRINT_COLLECTIONS.flatMap((c) => c.designIds.map((id) => [id, c.slug] as const)),
);

/** Collection slug for a design id, or undefined when unassigned. */
export function collectionOf(id: string): PrintCollectionSlug | undefined {
  return COLLECTION_BY_ID.get(id);
}

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

/**
 * Loads the real, CMS-managed fine-art-print collections — published state
 * only, never a draft. Mirrors PrintCollectionDefinition's shape so callers
 * (groupPrintDesigns, printDisplayName) can't tell a DB-loaded array from
 * the static one.
 *
 * `prints` is always returned empty: nothing in this codebase reads it
 * (only `.designIds` and `.name`/`.slug` are used by any current or Plan-1
 * caller — see print-curation.ts's own PRINT_COLLECTION_DEFINITIONS
 * construction, where `prints` mirrors curation-map metadata that has no DB
 * equivalent and no consumer).
 */
export async function loadPrintCollectionDefinitions(
  supabase: SupabaseClient,
): Promise<PrintCollectionDefinition[]> {
  const { data: collections, error: collectionsError } = await supabase
    .from('collections')
    .select('id, published_revision')
    .not('published_revision', 'is', null);
  if (collectionsError) throw collectionsError;

  const rows = (collections ?? []) as { id: string; published_revision: number }[];

  const definitions = await Promise.all(
    rows.map(async (row) => {
      const { data: draft, error: draftError } = await supabase
        .from('collection_drafts')
        .select('payload')
        .eq('collection_id', row.id)
        .eq('revision', row.published_revision)
        .maybeSingle();
      if (draftError) throw draftError;
      if (!draft) return null;

      const payload = draft.payload as { name: string; fields: CollectionField[] };
      const fields = payload.fields ?? [];
      const slugField = fields.find((f) => f.key === 'slug');
      const productsField = fields.find((f) => f.key === 'products');
      const designIds = productsField?.value
        ? productsField.value.split(',').map((id) => id.trim()).filter((id) => id.length > 0)
        : [];

      const definition: PrintCollectionDefinition = {
        slug: slugField?.value || row.id,
        name: payload.name,
        designIds,
        prints: [],
      };
      return definition;
    }),
  );

  return definitions.filter((d): d is PrintCollectionDefinition => d !== null);
}
