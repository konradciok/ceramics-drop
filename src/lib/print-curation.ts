import source from '../../config/print-catalog-curation.json';

/**
 * Static fallback source for print-collection naming/grouping — retained
 * deliberately, not dead code.
 *
 * As of the fine-art-collections migration (2026-09-16 plans 1+2), every
 * naming/grouping caller in this codebase (cart, invoices, analytics
 * overrides, feed, admin listings, account history, the storefront pages)
 * passes an explicit, CMS-loaded `definitions` array — sourced from
 * `loadPrintCollectionDefinitions()` in print-collections.ts — to
 * `printDisplayName`/`groupPrintDesigns`. This JSON-derived
 * `PRINT_COLLECTION_DEFINITIONS` export remains only as:
 *   1. The parameter default those functions fall back to. This isn't a
 *      hypothetical for some future caller — it's already live:
 *      `analytics.ts`'s print-item builders call `printDisplayName`
 *      without a `definitions` argument whenever no `nameOverride`/
 *      `itemName` override is supplied (e.g. the checkout-return
 *      purchase-confirmation flow), so this default is exercised in
 *      production today. `loadPrintCollectionDefinitions()` itself also
 *      falls back to it if the CMS-backed DB read fails or times out (see
 *      print-collections.ts's `readWithFallback` call).
 *   2. The same underlying JSON `source` this file also derives
 *      `PRINT_CURATION`/`ACTIVE_PRINT_CURATION`/`RETIRED_PRINT_CURATION`/
 *      `curationForProduct` from (independently, not through
 *      `PRINT_COLLECTION_DEFINITIONS`) — exports unrelated to collection
 *      naming/grouping that still power live, unaffected per-print
 *      publication-status consumers: `catalog/seed.ts`'s
 *      `catalogStatusForPrint` call and `src/lib/prints.ts`'s
 *      published/retired registry construction (`curationForProduct()` at
 *      prints.ts:504, explicitly out of scope per Plan 1's Global
 *      Constraints).
 * Neither reason makes this file or its exports dead code — do not delete
 * `config/print-catalog-curation.json` or remove any export here without
 * separately deciding to make `definitions` a required parameter
 * everywhere (a bigger, separate decision, out of scope for this plan).
 */

export type PrintCuration = {
  sourceNumber: string;
  productId: string;
  number?: string;
  seriesNumber?: string;
  status?: 'draft';
  collectionSlug?: string;
  duplicateOf?: string;
  reason?: string;
};

export type PrintCollectionDefinition = {
  slug: string;
  name: string;
  designIds: string[];
  prints: PrintCuration[];
  /** Localized editorial copy from the CMS `description` fields, keyed by locale. */
  descriptions?: Partial<Record<string, string>>;
};

export type PrintCurationSource = {
  schemaVersion: number;
  collections: Array<{ slug: string; name: string; prints: Array<{ sourceNumber: string; productId: string; number: string; seriesNumber?: string; status?: 'draft' }> }>;
  retired: Array<{ sourceNumber: string; productId: string; duplicateOf: string; reason: string }>;
};

const input = source as PrintCurationSource;

function fail(message: string): never {
  throw new Error(`Invalid print curation map: ${message}`);
}

export function validatePrintCuration(input: PrintCurationSource): void {
  if (input.schemaVersion !== 1) fail(`unsupported schemaVersion ${input.schemaVersion}`);
  if (!Array.isArray(input.collections) || !Array.isArray(input.retired)) fail('collections and retired must be arrays');
  const slugs = new Set<string>();
  const names = new Set<string>();
  for (const collection of input.collections) {
    if (!collection.slug?.trim() || !collection.name?.trim()) fail('every collection requires slug and name');
    if (slugs.has(collection.slug)) fail(`duplicate collection slug: ${collection.slug}`);
    if (names.has(collection.name)) fail(`duplicate collection name: ${collection.name}`);
    slugs.add(collection.slug);
    names.add(collection.name);
    if (!Array.isArray(collection.prints) || collection.prints.length === 0) {
      fail(`${collection.slug} must contain at least 1 print`);
    }
  }
  const active = input.collections.flatMap((collection) => collection.prints);
  const all = [...active, ...input.retired];
  const ids = new Set<string>();
  for (const item of all) {
    if (!/^\d{3,}$/.test(item.sourceNumber) || Number(item.sourceNumber) < 1
      || item.productId !== `fap${item.sourceNumber}`) {
      fail(`${item.productId} must match a positive sourceNumber of at least three digits`);
    }
    if (ids.has(item.productId)) fail(`duplicate product ID: ${item.productId}`);
    ids.add(item.productId);
    if ('status' in item && item.status !== 'draft') fail(`${item.productId} has an invalid status`);
    if ('seriesNumber' in item && !/^\d{2,}$/.test(item.seriesNumber ?? '')) fail(`${item.productId} has an invalid series number`);
  }
  // Global display numbers remain contiguous and unique. Collection-local
  // names and stable source IDs are separate; neither imposes a batch size.
  const expectedNumbers = active.map((_, index) => String(index + 1).padStart(2, '0'));
  if (active.map((item) => item.number).join() !== expectedNumbers.join()) {
    fail('active numbers must be consecutive from 01 in authored order');
  }
  for (const item of input.retired) {
    if (!item.reason?.trim()) fail(`${item.productId} requires a retirement reason`);
    if (!active.some((candidate) => candidate.productId === item.duplicateOf)) {
      fail(`${item.productId} duplicateOf must be active`);
    }
  }
}

/** Every source must be curated exactly once, including retired designs. */
export function validatePrintRegistry(sourceIds: readonly string[], curatedIds: readonly string[]): void {
  const sources = new Set(sourceIds);
  const curated = new Set(curatedIds);
  if (sources.size !== sourceIds.length || curated.size !== curatedIds.length
    || sources.size !== curated.size || [...curated].some((id) => !sources.has(id))) {
    throw new Error('Print curation and source registry must cover the same unique IDs');
  }
}

validatePrintCuration(input);

const active: PrintCuration[] = input.collections.flatMap((collection) => collection.prints.map((item) => ({ ...item, collectionSlug: collection.slug })));
const retired: PrintCuration[] = input.retired.map((item) => ({ ...item }));
const all = [...active, ...retired];

export const PRINT_CURATION = all;
export const ACTIVE_PRINT_CURATION = active.filter((item) => item.status !== 'draft');
export const DRAFT_PRINT_CURATION = active.filter((item) => item.status === 'draft');
export const RETIRED_PRINT_CURATION = retired;
export const PRINT_COLLECTION_DEFINITIONS: PrintCollectionDefinition[] = input.collections.map(({ slug, name, prints }) => ({
  slug,
  name,
  designIds: prints.map(({ productId }) => productId),
  prints: active.filter((item) => item.collectionSlug === slug),
}));

export function curationForProduct(id: string): PrintCuration | undefined {
  return active.find((item) => item.productId === id);
}

/** Customer-facing name, numbered independently in each authored collection.
 * Resolve by ID so code and database catalogues use the same names.
 */
export function printDisplayName(
  design: { id: string; num: string },
  fallback = 'Print',
  definitions: PrintCollectionDefinition[] = PRINT_COLLECTION_DEFINITIONS,
): string {
  for (const collection of definitions) {
    const index = collection.designIds.indexOf(design.id);
    if (index !== -1) {
      const curated = curationForProduct(design.id);
      // CMS definitions carry membership, while source series numbers remain
      // stable even when the works are reordered within their collection.
      const series = collection.prints.find((item) => item.productId === design.id)?.seriesNumber
        ?? (curated?.collectionSlug === collection.slug ? curated.seriesNumber : undefined);
      return `${collection.name} ${series ?? String(index + 1).padStart(2, '0')}`;
    }
  }
  return `${fallback} Nº ${design.num}`;
}

/** The collection a design belongs to (first match in array order, same rule as
 *  printDisplayName), or undefined for designs in no collection ('inne'). */
export function printCollectionOf(
  designId: string,
  definitions: PrintCollectionDefinition[] = PRINT_COLLECTION_DEFINITIONS,
): PrintCollectionDefinition | undefined {
  return definitions.find((c) => c.designIds.includes(designId));
}

export function catalogStatusForPrint(id: string): 'active' | 'draft' | 'archived' {
  const curated = curationForProduct(id);
  if (curated) return curated.status === 'draft' ? 'draft' : 'active';
  if (RETIRED_PRINT_CURATION.some((item) => item.productId === id)) return 'archived';
  throw new Error(`Unknown print ID: ${id}`);
}
