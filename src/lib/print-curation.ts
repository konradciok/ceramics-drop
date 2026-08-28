import source from '../../config/print-catalog-curation.json';

export type PrintCuration = {
  sourceNumber: string;
  productId: string;
  number?: string;
  collectionSlug?: string;
  duplicateOf?: string;
  reason?: string;
};

export type PrintCollectionDefinition = {
  slug: string;
  name: string;
  designIds: string[];
  prints: PrintCuration[];
};

type Source = {
  schemaVersion: number;
  collections: Array<{ slug: string; name: string; prints: Array<{ sourceNumber: string; productId: string; number: string }> }>;
  retired: Array<{ sourceNumber: string; productId: string; duplicateOf: string; reason: string }>;
};

const input = source as Source;

function fail(message: string): never {
  throw new Error(`Invalid print curation map: ${message}`);
}

if (input.schemaVersion !== 1) fail(`unsupported schemaVersion ${input.schemaVersion}`);
if (!Array.isArray(input.collections) || !Array.isArray(input.retired)) fail('collections and retired must be arrays');

const active: PrintCuration[] = input.collections.flatMap((collection) => {
  if (!collection.slug || !collection.name) fail('every collection requires slug and name');
  return collection.prints.map((item) => ({ ...item, collectionSlug: collection.slug }));
});
const retired: PrintCuration[] = input.retired.map((item) => ({ ...item }));
const all = [...active, ...retired];

for (const item of all) {
  if (item.productId !== `fap${item.sourceNumber}`) fail(`${item.productId} must match sourceNumber ${item.sourceNumber}`);
}
if (new Set(all.map((item) => item.productId)).size !== 41) fail('expected 41 unique product IDs');
if (active.length !== 39) fail(`expected 39 active mappings, got ${active.length}`);
const expectedNumbers = Array.from({ length: 39 }, (_, index) => String(index + 1).padStart(2, '0'));
if (active.map((item) => item.number).join() !== expectedNumbers.join()) fail('active numbers must be 01 through 39 in authored order');
if (new Set(active.map((item) => item.number)).size !== 39) fail('active numbers must be unique');
for (const collection of input.collections) {
  if (collection.prints.length < 4 || collection.prints.length > 5) fail(`${collection.slug} must contain 4 or 5 prints`);
}
for (const item of retired) {
  if (!active.some((candidate) => candidate.productId === item.duplicateOf)) fail(`${item.productId} duplicateOf must be active`);
}

export const PRINT_CURATION = all;
export const ACTIVE_PRINT_CURATION = active;
export const RETIRED_PRINT_CURATION = retired;
export const PRINT_COLLECTION_DEFINITIONS: PrintCollectionDefinition[] = input.collections.map(({ slug, name, prints }) => ({
  slug,
  name,
  designIds: prints.map(({ productId }) => productId),
  prints: active.filter((item) => item.collectionSlug === slug),
}));

export function curationForProduct(id: string): PrintCuration | undefined {
  return ACTIVE_PRINT_CURATION.find((item) => item.productId === id);
}

export function catalogStatusForPrint(id: string): 'active' | 'archived' {
  if (curationForProduct(id)) return 'active';
  if (RETIRED_PRINT_CURATION.some((item) => item.productId === id)) return 'archived';
  throw new Error(`Unknown print ID: ${id}`);
}
