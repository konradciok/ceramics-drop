# Fine-Art Collections Migration — Plan 1 (Storefront Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the 9 real fine-art-print collections (Ostrea, Gestures,
Linea, Horizons, Portals, Signs, Ciala, Balance, Verticles) live in the new
CMS `collections` table and have `/sklep`, the print PDP, the homepage, and
SEO structured data read their grouping/order/display-name from there
instead of the static `config/print-catalog-curation.json` — with zero
visible change to the live site at cutover.

**Architecture:** `printDisplayName()` and `groupPrintDesigns()` gain a
new, optional, backward-compatible `definitions` parameter (defaulting to
the existing static-JSON-backed constant), so every caller *outside* this
plan's 6 files needs zero changes. A new async loader reads
`collections`/`collection_drafts` (published state only) directly via
Supabase from within `ceramics-drop` (same DB, same deployment — no HTTP
hop through the CmsApi). A one-time backfill script creates and publishes
the 9 real collections in production via the same RPCs the CMS itself
uses, run *before* the code deploys, so there is no gap.

**Tech Stack:** Next.js (App Router, Cloudflare Workers via OpenNext),
Supabase (`@supabase/supabase-js`), Vitest, tsx (for the CLI script).

**Spec:** `docs/plans/2026-09-16-fine-art-collections-migration.md`

## Global Constraints

- `printDisplayName(design, fallback?, definitions?)` and
  `groupPrintDesigns(designs, definitions?)` MUST remain callable exactly
  as today with no third/second argument — every caller outside this
  plan's 6 files gets zero changes and identical behavior.
- The new loader reads `collections.published_revision` joined to
  `collection_drafts` at that revision — **never** an unpublished draft.
- `curationForProduct()` / the `published` gate in `getPrintDesigns()`
  (`src/lib/prints.ts:504`) is NOT touched by this plan — a print's
  fundamental visibility stays governed by the static JSON, unchanged.
- The backfill script uses the real `create_collection_with_draft` and
  `publish_collection_revision` RPCs — never raw `INSERT`/`UPDATE` against
  `collections`/`collection_drafts`.
- Collection `productIds` field value format: a comma-separated string of
  product ids, e.g. `"fap001,fap002,fap003,fap006,fap007"` — matches the
  existing `defaultFields()`/CMS convention exactly (see
  `src/server/cms-api/handlers/collections-create.ts`).
- Field shape (from the real contract):
  `{ key, label, type: "text"|"richtext"|"number"|"productIds", value, locale: "pl"|"en"|"es"|"de"|"none", sourceLocale }`.
- **Task 7 (the backfill) is a stop-and-ask point.** The script may be
  written, reviewed, and tested (against a local/mocked Supabase client)
  entirely autonomously. It must NOT be executed against real production
  Supabase without the human explicitly confirming, in this exact session,
  that they want it run now. This is a materially different risk tier
  from every other task in this plan.

---

### Task 1: Loader — `loadPrintCollectionDefinitions`

**Files:**
- Modify: `src/lib/print-collections.ts` (add the loader + a `slug`/`name` reader)
- Test: `src/lib/print-collections.test.ts` (new file)

**Interfaces:**
- Consumes: `SupabaseClient` (from `@supabase/supabase-js`, caller-provided
  — matches the existing `collections-mapping.ts` pattern of taking
  `supabase` as an explicit first argument, not importing a singleton).
- Produces: `loadPrintCollectionDefinitions(supabase: SupabaseClient): Promise<PrintCollectionDefinition[]>`,
  returning the same `PrintCollectionDefinition[]` shape
  (`{slug, name, designIds, prints}`) that `PRINT_COLLECTION_DEFINITIONS`
  already exports from `print-curation.ts`, so downstream code (Task 2)
  can treat a DB-loaded array and the static array identically.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/print-collections.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/print-collections.test.ts`
Expected: FAIL — `loadPrintCollectionDefinitions is not a function` (it
doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Add to `src/lib/print-collections.ts` (keep the existing exports —
`UNASSIGNED_COLLECTION`, `PRINT_COLLECTIONS`, `collectionOf`,
`groupPrintDesigns` — untouched by this step; Task 2 changes
`groupPrintDesigns`'s signature separately):

```typescript
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PrintCollectionDefinition } from './print-curation';

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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/print-collections.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Run the full existing test suite to confirm no regression**

Run: `npm run test`
Expected: PASS (this task added a new export, touched nothing existing).

- [ ] **Step 6: Commit**

```bash
git add src/lib/print-collections.ts src/lib/print-collections.test.ts
git commit -m "feat: add loader for CMS-managed print collections"
```

---

### Task 2: Optional `definitions` parameter on `printDisplayName` / `groupPrintDesigns`

**Files:**
- Modify: `src/lib/print-curation.ts:60-66` (`printDisplayName`)
- Modify: `src/lib/print-collections.ts` (`groupPrintDesigns`, `collectionOf`)
- Test: `src/lib/print-curation.test.ts` (extend if it exists, else create)
- Test: `src/lib/print-collections.test.ts` (extend from Task 1)

**Interfaces:**
- Consumes: `PrintCollectionDefinition[]` (Task 1's return type).
- Produces:
  `printDisplayName(design: {id: string; num: string}, fallback?: string, definitions?: PrintCollectionDefinition[]): string`
  and
  `groupPrintDesigns(designs: PrintDesign[], definitions?: PrintCollectionDefinition[]): {slug, name, designs}[]`
  — both default `definitions` to the existing static constants, so every
  call site not in this plan's remaining tasks needs no change.

- [ ] **Step 1: Write the failing test (printDisplayName)**

Add to `src/lib/print-curation.test.ts` (create the file if it doesn't
already exist — check first with
`git -C . show HEAD:src/lib/print-curation.test.ts` before assuming):

```typescript
import { describe, expect, it } from 'vitest';
import { printDisplayName } from './print-curation';
import type { PrintCollectionDefinition } from './print-curation';

describe('printDisplayName with an explicit definitions array', () => {
  it('uses the passed-in definitions instead of the static curation map', () => {
    const customDefinitions: PrintCollectionDefinition[] = [
      { slug: 'custom', name: 'Custom Collection', designIds: ['fap001', 'fap002'], prints: [] },
    ];
    // fap001 is "Ostrea 01" under the static map, but "Custom Collection 01"
    // under this explicit array — proves the parameter, not the module
    // constant, drives the result.
    expect(printDisplayName({ id: 'fap001', num: '01' }, 'Print', customDefinitions)).toBe(
      'Custom Collection 01',
    );
  });

  it('still uses the static curation map when no definitions argument is passed', () => {
    expect(printDisplayName({ id: 'fap001', num: '01' }, 'Print')).toBe('Ostrea 01');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/print-curation.test.ts`
Expected: FAIL on the first test (still resolves against the static map,
`'Ostrea 01' !== 'Custom Collection 01'`); second test passes already.

- [ ] **Step 3: Modify `printDisplayName`**

In `src/lib/print-curation.ts`, replace:

```typescript
export function printDisplayName(design: { id: string; num: string }, fallback = 'Print'): string {
  for (const collection of PRINT_COLLECTION_DEFINITIONS) {
    const index = collection.designIds.indexOf(design.id);
    if (index !== -1) return `${collection.name} ${String(index + 1).padStart(2, '0')}`;
  }
  return `${fallback} Nº ${design.num}`;
}
```

with:

```typescript
export function printDisplayName(
  design: { id: string; num: string },
  fallback = 'Print',
  definitions: PrintCollectionDefinition[] = PRINT_COLLECTION_DEFINITIONS,
): string {
  for (const collection of definitions) {
    const index = collection.designIds.indexOf(design.id);
    if (index !== -1) return `${collection.name} ${String(index + 1).padStart(2, '0')}`;
  }
  return `${fallback} Nº ${design.num}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/print-curation.test.ts`
Expected: PASS, both tests.

- [ ] **Step 5: Write the failing test (groupPrintDesigns)**

Add to `src/lib/print-collections.test.ts`:

```typescript
import { groupPrintDesigns } from './print-collections';
import type { PrintDesign } from './types';

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
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run src/lib/print-collections.test.ts`
Expected: FAIL — `groupPrintDesigns` doesn't accept a second argument yet
(TypeScript error / groups against the static map instead).

- [ ] **Step 7: Modify `groupPrintDesigns`**

In `src/lib/print-collections.ts`, replace:

```typescript
export function groupPrintDesigns(
  designs: PrintDesign[],
): { slug: PrintCollectionSlug; name?: string; designs: PrintDesign[] }[] {
  const byId = new Map(designs.map((d) => [d.id, d]));
  const groups: { slug: PrintCollectionSlug; name?: string; designs: PrintDesign[] }[] = PRINT_COLLECTIONS.map(({ slug, name, designIds }) => ({
    slug,
    name,
    designs: designIds.flatMap((id) => byId.get(id) ?? []),
  }));
  const rest = designs.filter((d) => !COLLECTION_BY_ID.has(d.id));
  groups.push({ slug: UNASSIGNED_COLLECTION, name: undefined, designs: rest });
  return groups.filter((g) => g.designs.length > 0);
}
```

with:

```typescript
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
```

(`collectionOf()` keeps using the module-level `COLLECTION_BY_ID` — it has
no caller in this plan's remaining tasks and isn't part of the migrated
surface; leave it exactly as-is.)

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run src/lib/print-collections.test.ts`
Expected: PASS, all tests including Task 1's.

- [ ] **Step 9: Run the full test suite**

Run: `npm run test`
Expected: PASS — no existing caller passes a second argument yet, so every
existing call site's behavior is unchanged (Global Constraint).

- [ ] **Step 10: Commit**

```bash
git add src/lib/print-curation.ts src/lib/print-curation.test.ts src/lib/print-collections.ts src/lib/print-collections.test.ts
git commit -m "feat: accept an optional definitions override in printDisplayName and groupPrintDesigns"
```

---

### Task 3: Wire `/sklep` to the CMS-loaded collections

**Files:**
- Modify: `src/app/[locale]/(collections)/sklep/page.tsx`
- Modify: `src/components/shop/PrintCollectionScreen.tsx`

**Interfaces:**
- Consumes: `loadPrintCollectionDefinitions` (Task 1),
  `getSupabaseAdmin()` (`src/lib/supabase.ts`, existing), the new
  `definitions` parameter on `printDisplayName`/`groupPrintDesigns`
  (Task 2).
- Produces: nothing new consumed by later tasks — this is a leaf wiring
  task.

- [ ] **Step 1: Read the current full files**

```bash
git -C . show HEAD:src/app/\[locale\]/\(collections\)/sklep/page.tsx
git -C . show HEAD:src/components/shop/PrintCollectionScreen.tsx
```

Confirm the exact current line numbers before editing — they may have
drifted since this plan was written; match by the code shapes shown below,
not blind line numbers.

- [ ] **Step 2: Wire `sklep/page.tsx`**

Add the import and load the definitions in both `generateMetadata` (for
the OG-image `alt` text) and `Page`:

```typescript
import { getSupabaseAdmin } from '@/lib/supabase';
import { loadPrintCollectionDefinitions } from '@/lib/print-collections';
```

In `generateMetadata`, before the `groupPrintDesigns(...)` call:

```typescript
const definitions = await loadPrintCollectionDefinitions(getSupabaseAdmin());
const [hero] = groupPrintDesigns(await getPrintDesigns(), definitions).flatMap((g) => g.designs);
```

and update the `alt` line a few lines below it:

```typescript
alt: printDisplayName(hero!, t('product.print'), definitions),
```

`Page` itself doesn't call `printDisplayName`/`groupPrintDesigns` directly
today (it delegates to `printCollectionSchema` and
`<PrintCollectionScreen>`) — Task 6 wires `printCollectionSchema`; this
step wires `<PrintCollectionScreen>` by passing `definitions` as a new
prop. Find:

```typescript
export default async function Page({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const [t, notes, pricing] = await Promise.all([
    getTranslations({ locale }),
    getProductNotes(PRINTS_SLUG, locale as Locale).catch(() => ({}) as Record<string, string>),
    getPrintPricingConfig(),
  ]);
  const schema = await printCollectionSchema({ locale: locale as Locale, t, tRaw: (key) => t.raw(key), notes, pricing });
  return (
    <main>
      <JsonLd data={schema} />
      <PrintCollectionScreen locale={locale as Locale} pricing={pricing} />
    </main>
  );
}
```

replace with:

```typescript
export default async function Page({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const [t, notes, pricing, definitions] = await Promise.all([
    getTranslations({ locale }),
    getProductNotes(PRINTS_SLUG, locale as Locale).catch(() => ({}) as Record<string, string>),
    getPrintPricingConfig(),
    loadPrintCollectionDefinitions(getSupabaseAdmin()),
  ]);
  const schema = await printCollectionSchema({ locale: locale as Locale, t, tRaw: (key) => t.raw(key), notes, pricing, definitions });
  return (
    <main>
      <JsonLd data={schema} />
      <PrintCollectionScreen locale={locale as Locale} pricing={pricing} definitions={definitions} />
    </main>
  );
}
```

(`generateMetadata` and `Page` are separate Next.js invocations, so this
is a second, independent call to the loader — matching how
`getPrintDesigns()` is already called independently in both functions in
this same file. That's the existing pattern in this codebase, not a new
inefficiency introduced by this change. The `printCollectionSchema` call
here already gains its `definitions` arg — Task 6 Step 4 does not need to
touch this specific call site again, only the PDP's.)

- [ ] **Step 3: Wire `PrintCollectionScreen.tsx`**

Add `definitions` to its props type and pass it through to
`groupPrintDesigns`/`printDisplayName`:

```typescript
import type { PrintCollectionDefinition } from '@/lib/print-curation';
```

Find the component's props type (something like
`{ locale: Locale; pricing: PrintPricingConfig }`) and add
`definitions: PrintCollectionDefinition[]`. Find:

```typescript
const groups = groupPrintDesigns(designs);
```

replace with:

```typescript
const groups = groupPrintDesigns(designs, definitions);
```

Find every `printDisplayName(d, t('product.print'))` (or similar) call
inside this file and add `definitions` as the third argument:

```typescript
const name = printDisplayName(d, t('product.print'), definitions);
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS — no type errors (both functions' new params are optional
with defaults, so this is purely additive; the new required
`definitions` prop on `PrintCollectionScreen` must be satisfied at its one
call site, which Step 2 already did).

- [ ] **Step 5: Run the full test suite**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "src/app/[locale]/(collections)/sklep/page.tsx" src/components/shop/PrintCollectionScreen.tsx
git commit -m "feat: wire /sklep to CMS-managed print collections"
```

---

### Task 4: Wire the print PDP to the CMS-loaded collections

**Files:**
- Modify: `src/app/[locale]/(pdp)/[slug]/[id]/page.tsx`
- Modify: `src/components/shop/PrintProductScreen.tsx`

**Interfaces:**
- Consumes: same as Task 3.
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Read the current full files**

```bash
git -C . show HEAD:"src/app/[locale]/(pdp)/[slug]/[id]/page.tsx"
git -C . show HEAD:src/components/shop/PrintProductScreen.tsx
```

- [ ] **Step 2: Wire `page.tsx`**

This file's `generateMetadata` and `Page` both have an
`if (slug === PRINT_SLUG) { ... }` branch that's the only place fine-art
prints are handled — the ceramics branch below it is untouched by this
plan. Add the import:

```typescript
import { getSupabaseAdmin } from '@/lib/supabase';
import { loadPrintCollectionDefinitions } from '@/lib/print-collections';
```

In `generateMetadata`'s print branch, find:

```typescript
  if (slug === PRINT_SLUG) {
    const design = await getPrintById(id);
    if (!design || !design.published) notFound();
    const t = await getTranslations({ locale });
    const singular = t('product.print');
    const displayName = printDisplayName(design, singular);
```

replace with:

```typescript
  if (slug === PRINT_SLUG) {
    const design = await getPrintById(id);
    if (!design || !design.published) notFound();
    const t = await getTranslations({ locale });
    const singular = t('product.print');
    const definitions = await loadPrintCollectionDefinitions(getSupabaseAdmin());
    const displayName = printDisplayName(design, singular, definitions);
```

In `Page`'s print branch, find:

```typescript
  if (slug === PRINT_SLUG) {
    const design = await getPrintById(id);
    if (!design || !design.published) notFound();
    const t = await getTranslations({ locale });
    const [note, coverage, pricing, pdpContent] = await Promise.all([
      getProductNote(PRINTS_SLUG, locale as Locale, design.id, previewToken),
      readWithFallback<PrintAssetCoverage | null>(
        'printAssetCoverage',
        () => getPrintAssetCoverage(design.id),
        null,
        { locale, id },
      ),
      getPrintPricingConfig(),
      getPrintPdpContent(locale as Locale, previewToken),
    ]);
```

replace with:

```typescript
  if (slug === PRINT_SLUG) {
    const design = await getPrintById(id);
    if (!design || !design.published) notFound();
    const t = await getTranslations({ locale });
    const [note, coverage, pricing, pdpContent, definitions] = await Promise.all([
      getProductNote(PRINTS_SLUG, locale as Locale, design.id, previewToken),
      readWithFallback<PrintAssetCoverage | null>(
        'printAssetCoverage',
        () => getPrintAssetCoverage(design.id),
        null,
        { locale, id },
      ),
      getPrintPricingConfig(),
      getPrintPdpContent(locale as Locale, previewToken),
      loadPrintCollectionDefinitions(getSupabaseAdmin()),
    ]);
```

and further down in the same branch, find:

```tsx
        <PrintProductScreen design={design} noteOverride={note} usableVariantKeys={usableVariantKeys} pricing={pricing} content={pdpContent} />
```

replace with:

```tsx
        <PrintProductScreen design={design} noteOverride={note} usableVariantKeys={usableVariantKeys} pricing={pricing} content={pdpContent} definitions={definitions} />
```

- [ ] **Step 3: Wire `PrintProductScreen.tsx`**

Add `definitions: PrintCollectionDefinition[]` to its props type (import
`PrintCollectionDefinition` from `@/lib/print-curation`), and add
`definitions` as the third argument to every `printDisplayName(...)` call
in the file — there are two in the current source: one for the main
`design`'s `displayName`, one inside a loop rendering related/other
prints.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Run the full test suite**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "src/app/[locale]/(pdp)/[slug]/[id]/page.tsx" src/components/shop/PrintProductScreen.tsx
git commit -m "feat: wire the print PDP to CMS-managed print collections"
```

---

### Task 5: Wire the homepage to the CMS-loaded collections

**Files:**
- Modify: `src/app/[locale]/page.tsx`

**Interfaces:**
- Consumes: same as Task 3.
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Read the current full file**

```bash
git -C . show HEAD:"src/app/[locale]/page.tsx"
```

- [ ] **Step 2: Wire it**

Add the import:

```typescript
import { getSupabaseAdmin } from '@/lib/supabase';
import { loadPrintCollectionDefinitions } from '@/lib/print-collections';
```

Find:

```typescript
const [printDesigns, printPricing, heroContent] = await Promise.all([
  getPrintDesigns(),
  getPrintPricingConfig(),
  getHomeContent(locale as CmsLocale, previewToken),
]);
```

replace with:

```typescript
const [printDesigns, printPricing, heroContent, definitions] = await Promise.all([
  getPrintDesigns(),
  getPrintPricingConfig(),
  getHomeContent(locale as CmsLocale, previewToken),
  loadPrintCollectionDefinitions(getSupabaseAdmin()),
]);
```

Find:

```typescript
const printName = (d: PrintDesign) => printDisplayName(d, t('product.print'));
```

replace with:

```typescript
const printName = (d: PrintDesign) => printDisplayName(d, t('product.print'), definitions);
```

Find:

```typescript
const collectionGroups = groupPrintDesigns(printDesigns);
```

replace with:

```typescript
const collectionGroups = groupPrintDesigns(printDesigns, definitions);
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Run the full test suite**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/[locale]/page.tsx"
git commit -m "feat: wire the homepage to CMS-managed print collections"
```

---

### Task 6: Wire SEO structured data

**Files:**
- Modify: `src/lib/seo/structured-data.ts`
- Modify: `src/app/[locale]/(pdp)/[slug]/[id]/page.tsx` (pass the new arg)
- (`sklep/page.tsx` needs no change in this task — Task 3 already wired
  its one `printCollectionSchema` call site)

**Interfaces:**
- Consumes: same as Task 3; also consumes Task 3's already-loaded
  `definitions` local variable in `sklep/page.tsx`'s `generateMetadata`
  and `Page` (`Page`'s `printCollectionSchema` call already passes it —
  see Task 3 Step 2 — nothing left to do there) and Task 4's in the PDP's
  `generateMetadata`/`Page` — no new loader call needed in either file,
  just pass the existing variable through.
- Produces: nothing new consumed by later tasks.

- [ ] **Step 1: Read the current full file**

```bash
git -C . show HEAD:src/lib/seo/structured-data.ts
```

- [ ] **Step 2: Modify `printCollectionSchema`**

Find:

```typescript
type PrintCollectionArgs = {
  locale: Locale;
  t: (key: string) => string;
  tRaw?: (key: string) => unknown;
  notes?: Record<string, string>;
  pricing: PrintPricingConfig;
};

export async function printCollectionSchema({ locale, t, tRaw, notes, pricing }: PrintCollectionArgs): Promise<Graph> {
  const designs = await getPrintDesigns();
```

replace with:

```typescript
type PrintCollectionArgs = {
  locale: Locale;
  t: (key: string) => string;
  tRaw?: (key: string) => unknown;
  notes?: Record<string, string>;
  pricing: PrintPricingConfig;
  definitions?: PrintCollectionDefinition[];
};

export async function printCollectionSchema({ locale, t, tRaw, notes, pricing, definitions }: PrintCollectionArgs): Promise<Graph> {
  const designs = await getPrintDesigns();
```

Find the `name: printDisplayName(d, singular),` line inside this function
and change to:

```typescript
name: printDisplayName(d, singular, definitions),
```

Add the import at the top of the file:

```typescript
import type { PrintCollectionDefinition } from '@/lib/print-curation';
```

(`PrintCollectionDefinition | undefined` is fine — `printDisplayName`'s
parameter already defaults to the static constant when `undefined` is
passed explicitly, same as when the argument is omitted entirely — no
extra handling needed here.)

- [ ] **Step 3: Modify `printProductSchema`**

Find:

```typescript
type PrintProductArgs = {
  design: PrintDesign;
  locale: Locale;
  t: (key: string) => string;
  tRaw: (key: string) => unknown;
  description?: string;
  pricing: PrintPricingConfig;
};

export function printProductSchema({ design, locale, t, tRaw, description: descriptionOverride, pricing }: PrintProductArgs): Graph {
  const { currency, priceCurrency } = printCurrencyFor(locale);
  const categoryName = t('nav.fineArtPrints');
  const singular = t('product.print');
  const name = printDisplayName(design, singular);
```

replace with:

```typescript
type PrintProductArgs = {
  design: PrintDesign;
  locale: Locale;
  t: (key: string) => string;
  tRaw: (key: string) => unknown;
  description?: string;
  pricing: PrintPricingConfig;
  definitions?: PrintCollectionDefinition[];
};

export function printProductSchema({ design, locale, t, tRaw, description: descriptionOverride, pricing, definitions }: PrintProductArgs): Graph {
  const { currency, priceCurrency } = printCurrencyFor(locale);
  const categoryName = t('nav.fineArtPrints');
  const singular = t('product.print');
  const name = printDisplayName(design, singular, definitions);
```

- [ ] **Step 4: Pass `definitions` from the remaining caller**

`sklep/page.tsx`'s `Page` function already passes `definitions` to
`printCollectionSchema` — that was done in Task 3 Step 2, nothing left to
do there. `sklep/page.tsx`'s `generateMetadata` doesn't call
`printCollectionSchema` at all (only `groupPrintDesigns`/`printDisplayName`,
already wired in Task 3 Step 2) — so no change needed in that file for
this task.

In the PDP `page.tsx`'s `Page` function's print branch, find the
`printProductSchema({...})` call:

```typescript
data={printProductSchema({
  design,
  locale: locale as Locale,
  t: (key: string) => t(key),
  tRaw: (key: string) => t.raw(key),
  description: note,
  pricing,
})}
```

and add `definitions` (Task 4's already-loaded local variable):

```typescript
data={printProductSchema({
  design,
  locale: locale as Locale,
  t: (key: string) => t(key),
  tRaw: (key: string) => t.raw(key),
  description: note,
  pricing,
  definitions,
})}
```

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Run the full test suite**

Run: `npm run test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/seo/structured-data.ts "src/app/[locale]/(pdp)/[slug]/[id]/page.tsx"
git commit -m "feat: wire SEO structured data to CMS-managed print collections"
```

---

### Task 7: Backfill script (⚠️ production data — stop-and-ask before running)

**Files:**
- Create: `scripts/backfill-fine-art-collections.ts`
- Modify: `package.json` (add an npm script entry)

**Interfaces:**
- Consumes: the real `create_collection_with_draft` and
  `publish_collection_revision` RPCs (already deployed, used by the
  CmsApi's `collections-create.ts`/`collections-publication.ts`),
  `loadSupabaseClient()` (`scripts/lib/script-env.ts`, existing).
- Produces: 9 real rows in `collections`/`collection_drafts` in whatever
  Supabase project the script is pointed at via `SUPABASE_URL`/
  `SUPABASE_SERVICE_ROLE_KEY`.

- [ ] **Step 1: Read the source data and an existing script for the exact CLI pattern**

```bash
git -C . show HEAD:config/print-catalog-curation.json
git -C . show HEAD:scripts/backfill-catalog.ts
git -C . show HEAD:scripts/lib/script-env.ts
```

- [ ] **Step 2: Write the script**

```typescript
// scripts/backfill-fine-art-collections.ts
/**
 * One-time backfill: creates and publishes the 9 real fine-art-print
 * collections (currently only in config/print-catalog-curation.json) in
 * the collections/collection_drafts tables, via the real
 * create_collection_with_draft / publish_collection_revision RPCs — the
 * same code path the CMS itself uses.
 *
 * Idempotent: skips any collection whose name already exists among
 * collection_drafts payloads, so a re-run after a partial failure does
 * not create duplicates.
 *
 * Usage:
 *   npm run backfill:fine-art-collections
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (.env.local / .dev.vars / env),
 * pointed at the target project explicitly before running — this writes
 * real, permanent rows (collections have no delete API) to whichever
 * project those credentials belong to. Confirm the target before running.
 */
import curationSource from '../config/print-catalog-curation.json';
import { loadSupabaseClient } from './lib/script-env';

type CurationCollection = { slug: string; name: string; prints: { productId: string }[] };
type CurationSource = { collections: CurationCollection[] };

const source = curationSource as CurationSource;

function generateCollectionId(): string {
  return `col_${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

function buildFields(name: string, slug: string, productIds: string[]) {
  return [
    { key: 'description', label: 'Opis kolekcji', type: 'text', value: `${name}.`, locale: 'pl', sourceLocale: 'pl' },
    { key: 'description', label: 'Opis kolekcji', type: 'text', value: '', locale: 'en', sourceLocale: 'pl' },
    { key: 'description', label: 'Opis kolekcji', type: 'text', value: '', locale: 'es', sourceLocale: 'pl' },
    { key: 'description', label: 'Opis kolekcji', type: 'text', value: '', locale: 'de', sourceLocale: 'pl' },
    { key: 'products', label: 'Produkty i kolejność', type: 'productIds', value: productIds.join(','), locale: 'none', sourceLocale: 'none' },
    { key: 'slug', label: 'Slug', type: 'text', value: slug, locale: 'none', sourceLocale: 'none' },
    // Scopes this collection into the fine-art-print storefront sections —
    // see src/lib/print-collections.ts's loadPrintCollectionDefinitions,
    // which only includes collections carrying this exact field/value.
    { key: 'kind', label: 'Rodzaj', type: 'text', value: 'print-collection', locale: 'none', sourceLocale: 'none' },
  ];
}

async function main(): Promise<void> {
  const supabase = loadSupabaseClient();
  const actorEmail = 'backfill-script@ceramics-drop.internal';

  const { data: existingRevisionOnes, error: existingError } = await supabase
    .from('collection_drafts')
    .select('payload')
    .eq('revision', 1);
  if (existingError) throw existingError;
  const existingNames = new Set(
    (existingRevisionOnes ?? []).map((row) => (row.payload as { name?: string })?.name),
  );

  for (const collection of source.collections) {
    if (existingNames.has(collection.name)) {
      console.log(`skip: "${collection.name}" already exists`);
      continue;
    }

    const productIds = collection.prints.map((p) => p.productId);
    const fields = buildFields(collection.name, collection.slug, productIds);
    let collectionId = generateCollectionId();

    let created = false;
    for (let attempt = 0; attempt < 3 && !created; attempt++) {
      const { error } = await supabase.rpc('create_collection_with_draft', {
        p_id: collectionId,
        p_payload: { name: collection.name, fields },
        p_actor_email: actorEmail,
      });
      if (!error) {
        created = true;
        break;
      }
      if (error.code === '23505' && attempt < 2) {
        collectionId = generateCollectionId();
        continue;
      }
      throw error;
    }

    const { error: publishError } = await supabase.rpc('publish_collection_revision', {
      p_collection_id: collectionId,
      p_expected_revision: 1,
      p_actor_email: actorEmail,
    });
    if (publishError) throw publishError;

    console.log(`created + published: "${collection.name}" (${collectionId}, ${productIds.length} products)`);
  }

  console.log('\nFine-art collections backfill complete.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
```

- [ ] **Step 3: Add the npm script**

In `package.json`'s `scripts` block, add (alongside the existing
`catalog:backfill` entry):

```json
"backfill:fine-art-collections": "tsx scripts/backfill-fine-art-collections.ts",
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Dry-run test against a local/mocked Supabase — NOT production**

Write a small manual smoke test using a throwaway local Supabase project
or the `ceramics-cms-integration` project (ref `ntqmlhcqmhjlcjtkeocc` —
the isolated test project already used elsewhere in this overall effort,
NOT production) to confirm the script runs end-to-end without error and
produces 9 rows with the expected shape. Do this by pointing
`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` at that project's credentials
via `.env.local` or `--env-file`, running
`npm run backfill:fine-art-collections`, then verifying via SQL:

```sql
select c.id, c.published_revision, cd.payload->>'name' as name,
       cd.payload->'fields'->4->>'value' as product_ids
from collections c
join collection_drafts cd on cd.collection_id = c.id and cd.revision = c.published_revision
order by c.created_at, c.id;
```

Expected: 9 rows, each with `published_revision = 1` and a non-empty
`product_ids` CSV. Clean these up afterward (collections have no delete
API — direct SQL `delete from collection_drafts where collection_id in (...); delete from collections where id in (...);`
against the test project only, never production) so the test project
stays a clean baseline for other work.

- [ ] **Step 6: Commit**

```bash
git add scripts/backfill-fine-art-collections.ts package.json
git commit -m "feat: add fine-art collections backfill script"
```

- [ ] **Step 7: STOP — do not proceed to running this against production**

**This is the plan's stop-and-ask point.** Report back to the human
partner that the script is written, tested against the isolated test
project, and ready — and explicitly ask whether to run
`npm run backfill:fine-art-collections` against real production Supabase
(project "ceramics", ref `wnlysejenowymjdxlnaq`) now. Do not run it
autonomously. Wait for explicit confirmation before Task 8.

---

### Task 8: Production backfill + deploy + verification

**Files:** none (operational task — running commands and verifying, no
new code).

**Interfaces:**
- Consumes: Task 7's script, Tasks 1-6's code (already merged/committed on
  this branch by this point).

**Preconditions:** Task 7's stop-and-ask has been explicitly confirmed by
the human partner in this session.

- [ ] **Step 1: Run the backfill against real production**

Point `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` at the production
project (ref `wnlysejenowymjdxlnaq`) and run:

```bash
npm run backfill:fine-art-collections
```

Expected output: 9 `created + published:` lines, one per collection, no
errors.

- [ ] **Step 2: Verify the backfill directly via SQL**

```sql
select c.id, c.published_revision, cd.payload->>'name' as name,
       jsonb_array_length(cd.payload->'fields') as n_fields
from collections c
join collection_drafts cd on cd.collection_id = c.id and cd.revision = c.published_revision
order by c.created_at, c.id;
```

Expected: 9 rows, `published_revision = 1`, `n_fields = 6` each, names
matching Ostrea/Gestures/Linea/Horizons/Portals/Signs/Ciala/Balance/
Verticles exactly.

- [ ] **Step 3: Build and deploy**

```bash
npm run build:opennext
npx wrangler deploy
```

(No `--env` flag — this deploys to the real production Worker, not
`ceramics-drop-preview`. Confirm this is intentional and expected before
running; this is the actual production storefront.)

- [ ] **Step 4: Live verification**

Load `/sklep` in a real browser (both a locale that's been tested before,
e.g. `/pl/sklep`, and confirm no console errors) and confirm:
- All 9 collection section headings appear, in the same order as before
  (Ostrea, Gestures, Linea, Horizons, Portals, Signs, Ciala, Balance,
  Verticles).
- Product counts and order within each section match what was live
  before this change (compare against a screenshot or the JSON file's
  order if unsure).
- Print names read correctly (e.g. hovering/opening the first Ostrea
  print should show "Ostrea 01").

Then load one print PDP directly (e.g. `/pl/fine-art-prints/fap001`) and
confirm the title/name still reads "Ostrea 01" (or whatever that specific
print's correct name is).

Then load the homepage (`/pl`) and confirm the print collections section
renders identically to before.

- [ ] **Step 5: Report results**

Report what was actually observed (not just "it deployed") — screenshots
or explicit confirmation of each check in Step 4, per this project's
standing convention that a passing build is not sufficient evidence for a
UI-facing change.

---

## Self-Review Notes

- **Spec coverage:** Architecture (Task 1), async/sync signature design
  (Task 2), all 4 storefront-facing consumer groups from the spec's
  caller list (Tasks 3-6), backfill with the correct RPC-based approach
  and idempotency (Task 7), production sequencing — backfill before
  deploy (Task 8), verification (Task 8 Step 4). Cleanup and Plan-2
  callers are explicitly out of this plan per the spec's own staging
  decision — no task needed here.
- **Placeholder scan:** no TBD/TODO; every step shows exact code or exact
  SQL/commands.
- **Type consistency:** `PrintCollectionDefinition` (Task 1's return
  element type) flows unchanged through Tasks 2-6 as the `definitions`
  parameter type everywhere it appears — `printDisplayName`,
  `groupPrintDesigns`, `PrintCollectionScreen`'s and
  `PrintProductScreen`'s new prop, `printCollectionSchema`'s and
  `printProductSchema`'s new arg. No renamed variants.
