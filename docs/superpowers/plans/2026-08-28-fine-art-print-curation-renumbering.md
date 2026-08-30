# Fine-Art Print Curation and Renumbering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce one machine-readable source of truth that maps the 41 source print numbers to 39 active, sequentially numbered storefront prints in nine fixed-name collections, while safely archiving `fap029` and `fap037` without changing stable product IDs.

**Architecture:** `config/print-catalog-curation.json` is the sole authored mapping for collection order, collection display names, source numbers, stable product IDs, new display numbers, and retired duplicates. A small typed module validates and projects that file into the code registry and collection UI. Supabase receives the same projection through an atomic data migration; product IDs, asset paths, R2 keys, order references, note indexes, and fulfilment history remain unchanged.

**Tech Stack:** Next.js 16, TypeScript, JSON config imported through `resolveJsonModule`, Vitest, Supabase/PostgreSQL.

**Spec:** `config/print-catalog-curation.json` (created in Task 1; authoritative after approval)

## Global Constraints

- Collection display names are exact and locale-independent: `Ostrea`, `Gestures`, `Linea`, `Horizons`, `Portals`, `Signs`, `Ciala`, `Balance`, `Verticles`.
- Preserve the spelling `Verticles` and the unaccented spelling `Ciala` exactly as supplied.
- Active display numbers are exactly `01` through `39`, with two digits and no gaps.
- Keep `fap001` through `fap041` as stable operational product IDs; never renumber IDs, URLs, cart tokens, order items, Prodigi records, asset assignments, R2 keys, or config filenames.
- Archive `fap029` and `fap037`; do not delete their rows, asset configs, uploaded assets, media, or historical references.
- **Archived-number rule:** retired entries deliberately carry no authored `number` in the JSON. Their display/DB number is defined by one rule, not authored: an archived design's `num` is its three-digit `sourceNumber` (`fap029` → `029`, `fap037` → `037`). Three digits can never collide with the two-digit active range `01`–`39`. The TypeScript projection (`number ?? sourceNumber`), the catalog seed, and the SQL migration must all apply this same rule, and a test must pin it.
- Keep every design's existing `noteIndex`; the new display order must not reassign translated/CMS copy.
- Every active collection contains four or five prints. `fap041` moves from `Ciala` to `Linea` so the 39 active designs satisfy this rule after the two removals.
- The mapping lands and is reviewed before any storefront or Supabase behavior changes.

---

## File Structure

- Create `config/print-catalog-curation.json` — only authored source for the curation, renumbering, and retired-duplicate mapping.
- Create `src/lib/print-curation.ts` — validate the JSON once and expose typed, derived lookups/projections; it must contain no second hand-written membership list.
- Create `src/lib/print-curation.test.ts` — pin mapping completeness, sequence, collection sizes, stable-ID correspondence, and retired duplicates.
- Modify `src/lib/prints.ts` — keep raw visual/product metadata keyed by stable IDs; derive `num`, `published`, status, and registry order from the curation module.
- Modify `src/lib/prints.test.ts` — pin the exact 39-ID active order and `01`–`39` display numbers.
- Modify `src/lib/print-collections.ts` — derive collection membership, order, slugs, and fixed display names from the curation module.
- Modify `src/lib/print-collections.test.ts` — assert the nine exact names and 4–5 members per collection.
- Modify `src/components/shop/PrintCollectionScreen.tsx` — render the fixed collection name from the mapping, not an i18n lookup.
- Modify `messages/{pl,en,es,de}.json` — remove obsolete translated curated names; retain only the resilience fallback label if the fallback bucket remains.
- Modify `src/lib/cms/schemas.ts` and `src/lib/cms/messages.ts` — make fallback-note lookup explicitly use stable `noteIndex`, not the newly reordered registry position.
- Modify/add CMS tests under `src/lib/cms/` — prove renumbering cannot attach one design's note to another design.
- Modify `src/lib/catalog/seed.ts` — emit `active` for mapped designs and `archived` for `fap029`/`fap037` from the same mapping.
- Modify catalog parity tests under `src/lib/catalog/` — pin new numbers, order, statuses, and DB/code parity.
- Create `supabase/migrations/20260828120000_curate_fine_art_prints.sql` — atomic data projection of the approved mapping into existing product rows; no identifier or asset-table rewrites.
- Modify `docs/STATUS.md` — replace stale print-catalog state with 39 active designs, nine fixed-name collections, and the verification date.
- Modify `docs/print-asset-runbook.md` only where it currently assumes all registry designs are active or numbered 1:1.

---

### Task 1: Add and validate the mapping source of truth

**Files:**
- Create: `config/print-catalog-curation.json`
- Create: `src/lib/print-curation.ts`
- Create: `src/lib/print-curation.test.ts`

**Interfaces:**
- Consumes: the stable source relationship `print-NNN` → `fapNNN`.
- Produces: `PRINT_CURATION`, `ACTIVE_PRINT_CURATION`, `RETIRED_PRINT_CURATION`, `PRINT_COLLECTION_DEFINITIONS`, `curationForProduct(id)`, and `catalogStatusForPrint(id)`.

- [ ] **Step 1: Write the exact mapping file, without changing any consumer**

Create `config/print-catalog-curation.json` with this complete content:

```json
{
  "schemaVersion": 1,
  "collections": [
    {
      "slug": "ostrea",
      "name": "Ostrea",
      "prints": [
        { "sourceNumber": "001", "productId": "fap001", "number": "01" },
        { "sourceNumber": "002", "productId": "fap002", "number": "02" },
        { "sourceNumber": "003", "productId": "fap003", "number": "03" },
        { "sourceNumber": "006", "productId": "fap006", "number": "04" },
        { "sourceNumber": "007", "productId": "fap007", "number": "05" }
      ]
    },
    {
      "slug": "gestures",
      "name": "Gestures",
      "prints": [
        { "sourceNumber": "010", "productId": "fap010", "number": "06" },
        { "sourceNumber": "012", "productId": "fap012", "number": "07" },
        { "sourceNumber": "014", "productId": "fap014", "number": "08" },
        { "sourceNumber": "016", "productId": "fap016", "number": "09" }
      ]
    },
    {
      "slug": "linea",
      "name": "Linea",
      "prints": [
        { "sourceNumber": "011", "productId": "fap011", "number": "10" },
        { "sourceNumber": "018", "productId": "fap018", "number": "11" },
        { "sourceNumber": "036", "productId": "fap036", "number": "12" },
        { "sourceNumber": "041", "productId": "fap041", "number": "13" }
      ]
    },
    {
      "slug": "horizons",
      "name": "Horizons",
      "prints": [
        { "sourceNumber": "005", "productId": "fap005", "number": "14" },
        { "sourceNumber": "023", "productId": "fap023", "number": "15" },
        { "sourceNumber": "026", "productId": "fap026", "number": "16" },
        { "sourceNumber": "038", "productId": "fap038", "number": "17" },
        { "sourceNumber": "039", "productId": "fap039", "number": "18" }
      ]
    },
    {
      "slug": "portals",
      "name": "Portals",
      "prints": [
        { "sourceNumber": "024", "productId": "fap024", "number": "19" },
        { "sourceNumber": "027", "productId": "fap027", "number": "20" },
        { "sourceNumber": "030", "productId": "fap030", "number": "21" },
        { "sourceNumber": "031", "productId": "fap031", "number": "22" },
        { "sourceNumber": "032", "productId": "fap032", "number": "23" }
      ]
    },
    {
      "slug": "signs",
      "name": "Signs",
      "prints": [
        { "sourceNumber": "004", "productId": "fap004", "number": "24" },
        { "sourceNumber": "008", "productId": "fap008", "number": "25" },
        { "sourceNumber": "025", "productId": "fap025", "number": "26" },
        { "sourceNumber": "033", "productId": "fap033", "number": "27" }
      ]
    },
    {
      "slug": "ciala",
      "name": "Ciala",
      "prints": [
        { "sourceNumber": "019", "productId": "fap019", "number": "28" },
        { "sourceNumber": "020", "productId": "fap020", "number": "29" },
        { "sourceNumber": "021", "productId": "fap021", "number": "30" },
        { "sourceNumber": "034", "productId": "fap034", "number": "31" }
      ]
    },
    {
      "slug": "balance",
      "name": "Balance",
      "prints": [
        { "sourceNumber": "015", "productId": "fap015", "number": "32" },
        { "sourceNumber": "028", "productId": "fap028", "number": "33" },
        { "sourceNumber": "035", "productId": "fap035", "number": "34" },
        { "sourceNumber": "040", "productId": "fap040", "number": "35" }
      ]
    },
    {
      "slug": "verticles",
      "name": "Verticles",
      "prints": [
        { "sourceNumber": "009", "productId": "fap009", "number": "36" },
        { "sourceNumber": "013", "productId": "fap013", "number": "37" },
        { "sourceNumber": "017", "productId": "fap017", "number": "38" },
        { "sourceNumber": "022", "productId": "fap022", "number": "39" }
      ]
    }
  ],
  "retired": [
    {
      "sourceNumber": "029",
      "productId": "fap029",
      "duplicateOf": "fap011",
      "reason": "near-duplicate composition"
    },
    {
      "sourceNumber": "037",
      "productId": "fap037",
      "duplicateOf": "fap016",
      "reason": "near-duplicate composition"
    }
  ]
}
```

- [ ] **Step 2: Write failing integrity tests**

Test all of the following in `src/lib/print-curation.test.ts`:

```ts
expect(PRINT_COLLECTION_DEFINITIONS.map(({ name }) => name)).toEqual([
  'Ostrea', 'Gestures', 'Linea', 'Horizons', 'Portals',
  'Signs', 'Ciala', 'Balance', 'Verticles',
]);
expect(ACTIVE_PRINT_CURATION.map(({ number }) => number)).toEqual(
  Array.from({ length: 39 }, (_, i) => String(i + 1).padStart(2, '0')),
);
expect(PRINT_COLLECTION_DEFINITIONS.every(({ prints }) => prints.length >= 4 && prints.length <= 5)).toBe(true);
expect(RETIRED_PRINT_CURATION.map(({ productId }) => productId)).toEqual(['fap029', 'fap037']);
```

Also assert:

```ts
for (const item of PRINT_CURATION) {
  expect(item.productId).toBe(`fap${item.sourceNumber}`);
}
expect(new Set(PRINT_CURATION.map((item) => item.productId)).size).toBe(41);
expect(new Set(ACTIVE_PRINT_CURATION.map((item) => item.number)).size).toBe(39);
for (const retired of RETIRED_PRINT_CURATION) {
  expect(ACTIVE_PRINT_CURATION.some((item) => item.productId === retired.duplicateOf)).toBe(true);
}
// Archived-number rule: retired entries author no `number`; their num is the
// three-digit sourceNumber, which cannot collide with the active 01–39 range.
for (const retired of RETIRED_PRINT_CURATION) {
  expect(retired).not.toHaveProperty('number');
  expect(retired.sourceNumber).toMatch(/^\d{3}$/);
}
```

- [ ] **Step 3: Run the focused test and verify it fails**

Run: `npx vitest run src/lib/print-curation.test.ts`

Expected: FAIL because `src/lib/print-curation.ts` and its exports do not exist.

- [ ] **Step 4: Implement the typed projection and fail-fast validation**

Implement `src/lib/print-curation.ts` so it imports the JSON, validates `schemaVersion === 1`, flattens collection entries in authored order, appends retired entries only to the all-record lookup, and throws descriptive errors for every invariant tested above. The module must export collection objects containing `slug`, `name`, and `designIds`; downstream code must not restate membership.

`catalogStatusForPrint(id)` returns `'active'` for an active mapping row and `'archived'` for a retired row, and throws for an unknown ID. `curationForProduct(id)` returns the active mapping row or `undefined` for retired/unknown IDs.

- [ ] **Step 5: Run the focused test and verify it passes**

Run: `npx vitest run src/lib/print-curation.test.ts`

Expected: PASS with 39 active mappings, 2 retired mappings, and nine valid collections.

- [ ] **Step 6: Review the mapping before any consumer change**

Review `git diff -- config/print-catalog-curation.json src/lib/print-curation.ts src/lib/print-curation.test.ts` and compare it to the visual curation. Stop here for studio approval. No file in `src/lib/prints.ts`, no message file, and no Supabase migration may change in this first review commit.

- [ ] **Step 7: Commit the approved source of truth**

```bash
git add config/print-catalog-curation.json src/lib/print-curation.ts src/lib/print-curation.test.ts
git commit -m "chore: define fine art print curation map"
```

---

### Task 2: Derive the print registry from the approved mapping

**Files:**
- Modify: `src/lib/prints.ts`
- Modify: `src/lib/types.ts`
- Modify: `src/lib/prints.test.ts`
- Modify: `src/lib/cms/schemas.ts`
- Modify: `src/lib/cms/messages.ts`
- Test: `src/lib/cms/schemas.test.ts`
- Create or modify: `src/lib/cms/messages.test.ts`

**Interfaces:**
- Consumes: `ACTIVE_PRINT_CURATION`, `RETIRED_PRINT_CURATION`, `curationForProduct(id)`.
- Produces: `PRINT_DESIGNS_RAW` containing 39 active and 2 unpublished/archived projections; `registryPrintDesigns()` and `getPrintDesigns()` ordered by new display number.

- [ ] **Step 1: Write failing registry-order tests**

Replace the old `fap001`–`fap041` sequence assertion with:

```ts
const expectedIds = ACTIVE_PRINT_CURATION.map(({ productId }) => productId);
expect((await getPrintDesigns()).map(({ id }) => id)).toEqual(expectedIds);
expect((await getPrintDesigns()).map(({ num }) => num)).toEqual(
  Array.from({ length: 39 }, (_, i) => String(i + 1).padStart(2, '0')),
);
// Archived-number rule: retired projections carry their three-digit sourceNumber.
expect(await getPrintById('fap029')).toMatchObject({ published: false, num: '029' });
expect(await getPrintById('fap037')).toMatchObject({ published: false, num: '037' });
```

Add a test that all 41 stable IDs still exist in `PRINT_DESIGNS_RAW`, while `registryPrintDesigns()` exposes only the 39 active IDs.

- [ ] **Step 2: Run the registry test and verify it fails**

Run: `npx vitest run src/lib/prints.test.ts`

Expected: FAIL because the registry still exposes 41 active, unpadded, source-order designs.

- [ ] **Step 3: Make raw metadata unable to author numbering or publication state**

In `src/lib/prints.ts`, change the existing registry constant from `PrintDesign[]` to `PrintSourceDesign[]`:

```ts
type PrintSourceDesign = Omit<PrintDesign, 'num' | 'published'>;
```

Rename the current `RAW_PRINT_DESIGNS` literal array to `SOURCE_PRINT_DESIGNS`, annotate it as `PrintSourceDesign[]`, and remove every hand-authored `num` and `published` property from those 41 literals. Materialize `PRINT_DESIGNS_RAW` by iterating the mapping, looking up each stable `productId`, applying the archived-number rule for `num` (`curation.number ?? curation.sourceNumber` — active rows use their mapped two-digit `number`, retired rows their three-digit `sourceNumber`), and setting `published` from active/retired state. Throw if the mapping and source registry do not cover the same 41 IDs. Keep `id`, image paths, editorial galleries, `noteIndex`, variants, mockup flags, and asset configuration references unchanged.

- [ ] **Step 4: Update the display-number contract**

Change the `PrintDesign.num` comment in `src/lib/types.ts` from unpadded output to:

```ts
num: string; // active display number, two digits, e.g. '01'
```

- [ ] **Step 5: Write a failing note-identity regression test**

Use two active designs whose new order differs from source order, for example `fap010` and `fap005`. Assert that `fallbackProductNotes('fine-art-prints', 'pl')` resolves each ID through its unchanged `noteIndex`, not through its new array position. Also assert that retired IDs are absent from the returned live-note map.

- [ ] **Step 6: Fix fallback-note lookup**

In `src/lib/cms/schemas.ts`, expose note entries as `{ id, noteIndex }` while preserving `productNoteIds()` for payload validation. In `src/lib/cms/messages.ts`, replace positional zipping with:

```ts
for (const { id, noteIndex } of productNoteEntries(slug) ?? []) {
  out[id] = Array.isArray(arr) ? arr[noteIndex] ?? '' : '';
}
```

Do not reorder or compact `messages.*.notes['fine-art-prints']`; holes for retired IDs are intentional and preserve copy identity.

- [ ] **Step 7: Run registry and CMS tests**

Run: `npx vitest run src/lib/prints.test.ts src/lib/cms/schemas.test.ts src/lib/cms/messages.test.ts`

Expected: PASS; 39 active designs are in new number order, both retired designs remain addressable but unpublished, and fallback notes remain bound to stable IDs.

- [ ] **Step 8: Commit the registry projection**

```bash
git add src/lib/prints.ts src/lib/types.ts src/lib/prints.test.ts src/lib/cms/schemas.ts src/lib/cms/messages.ts src/lib/cms/schemas.test.ts src/lib/cms/messages.test.ts
git commit -m "feat: derive print numbering from curation map"
```

---

### Task 3: Render the nine fixed-name collections

**Files:**
- Modify: `src/lib/print-collections.ts`
- Modify: `src/lib/print-collections.test.ts`
- Modify: `src/components/shop/PrintCollectionScreen.tsx`
- Modify: `messages/pl.json`
- Modify: `messages/en.json`
- Modify: `messages/es.json`
- Modify: `messages/de.json`

**Interfaces:**
- Consumes: `PRINT_COLLECTION_DEFINITIONS` from `src/lib/print-curation.ts`.
- Produces: collection groups shaped as `{ slug, name, designs }`, with `name` identical in every locale.

- [ ] **Step 1: Replace the empty-curation tests with exact collection tests**

Assert:

```ts
const groups = groupPrintDesigns(registryPrintDesigns());
expect(groups.map(({ name }) => name)).toEqual([
  'Ostrea', 'Gestures', 'Linea', 'Horizons', 'Portals',
  'Signs', 'Ciala', 'Balance', 'Verticles',
]);
expect(groups.map(({ designs }) => designs.length)).toEqual([5, 4, 4, 5, 5, 4, 4, 4, 4]);
expect(groups.flatMap(({ designs }) => designs.map(({ num }) => num))).toEqual(
  Array.from({ length: 39 }, (_, i) => String(i + 1).padStart(2, '0')),
);
```

Keep a fallback test for an unknown DB-created design so production does not crash on catalog drift.

- [ ] **Step 2: Run the focused collection test and verify it fails**

Run: `npx vitest run src/lib/print-collections.test.ts`

Expected: FAIL because `PRINT_COLLECTIONS` is empty and groups do not expose `name`.

- [ ] **Step 3: Derive collections instead of restating them**

Build `PRINT_COLLECTIONS` directly from `PRINT_COLLECTION_DEFINITIONS`. Retain the unassigned fallback only for unexpected DB rows; current registry tests must prove no active mapped design reaches it.

- [ ] **Step 4: Render mapping names directly**

In `PrintCollectionScreen.tsx`, replace both curated calls to:

```tsx
t(`printCollections.${g.slug}`)
```

with:

```tsx
g.name
```

For a fallback group only, retain a localized fallback label. Do not copy the nine names into four message files.

- [ ] **Step 5: Remove obsolete translated collection entries**

Delete `ultramaryna`, `miedz`, `agat`, `szalwia`, and `nokturn` from each locale's `printCollections` object. Keep only the fallback key used by the UI, if the fallback path remains.

- [ ] **Step 6: Run the collection and message tests**

Run: `npx vitest run src/lib/print-collections.test.ts`

Expected: PASS; collection names originate once from the mapping and render identically for `pl`, `en`, `es`, and `de`.

- [ ] **Step 7: Commit collection rendering**

```bash
git add src/lib/print-collections.ts src/lib/print-collections.test.ts src/components/shop/PrintCollectionScreen.tsx messages/pl.json messages/en.json messages/es.json messages/de.json
git commit -m "feat: curate fine art print collections"
```

---

### Task 4: Project the mapping into the DB catalog safely

**Files:**
- Modify: `src/lib/catalog/seed.ts`
- Modify: `src/lib/catalog/catalog-parity.test.ts`
- Modify: `src/lib/catalog/catalog-read-parity.test.ts`
- Modify: `src/lib/print-curation.test.ts` (migration-snapshot parity test)
- Create: `supabase/migrations/20260828120000_curate_fine_art_prints.sql`

**Interfaces:**
- Consumes: `catalogStatusForPrint(id)` and mapped `PrintDesign.num`.
- Produces: code seed rows and live Supabase product rows with identical `num` and `status` values.

- [ ] **Step 1: Write failing seed assertions**

Add assertions that the print seed contains 41 stable product rows, exactly 39 `active` rows numbered `01`–`39`, and these archived rows:

```ts
// Archived-number rule: seed rows for retired designs carry the three-digit sourceNumber.
expect(printRowsById.get('fap029')).toMatchObject({ num: '029', status: 'archived' });
expect(printRowsById.get('fap037')).toMatchObject({ num: '037', status: 'archived' });
```

Also assert the 39 active rows sorted by `num` round-trip to the same order as `registryPrintDesigns()`.

- [ ] **Step 2: Run catalog parity tests and verify they fail**

Run: `npx vitest run src/lib/catalog/catalog-parity.test.ts src/lib/catalog/catalog-read-parity.test.ts`

Expected: FAIL because false publication currently seeds `draft`, not the mapping's explicit `archived` state.

- [ ] **Step 3: Make the seed use mapping status**

In `src/lib/catalog/seed.ts`, replace:

```ts
status: d.published ? 'active' : 'draft',
```

with the validated `catalogStatusForPrint(d.id)` result. Keep variants and media in place for archived products; mark their variants inactive through the existing `active: d.published` behavior.

- [ ] **Step 4: Add one atomic data migration**

Create `supabase/migrations/20260828120000_curate_fine_art_prints.sql` with this atomic projection and its postconditions:

```sql
begin;

-- One list drives both the projection and every postcondition, so the update
-- and its verification cannot drift onto different assignments inside this
-- migration. The same list is pinned row-by-row against
-- config/print-catalog-curation.json by a Vitest test (Step 5 below).
create temporary table print_curation_map (
  id text primary key,
  num text not null,
  status text not null check (status in ('active', 'archived'))
) on commit drop;

insert into print_curation_map (id, num, status)
values
    ('fap001', '01', 'active'),
    ('fap002', '02', 'active'),
    ('fap003', '03', 'active'),
    ('fap006', '04', 'active'),
    ('fap007', '05', 'active'),
    ('fap010', '06', 'active'),
    ('fap012', '07', 'active'),
    ('fap014', '08', 'active'),
    ('fap016', '09', 'active'),
    ('fap011', '10', 'active'),
    ('fap018', '11', 'active'),
    ('fap036', '12', 'active'),
    ('fap041', '13', 'active'),
    ('fap005', '14', 'active'),
    ('fap023', '15', 'active'),
    ('fap026', '16', 'active'),
    ('fap038', '17', 'active'),
    ('fap039', '18', 'active'),
    ('fap024', '19', 'active'),
    ('fap027', '20', 'active'),
    ('fap030', '21', 'active'),
    ('fap031', '22', 'active'),
    ('fap032', '23', 'active'),
    ('fap004', '24', 'active'),
    ('fap008', '25', 'active'),
    ('fap025', '26', 'active'),
    ('fap033', '27', 'active'),
    ('fap019', '28', 'active'),
    ('fap020', '29', 'active'),
    ('fap021', '30', 'active'),
    ('fap034', '31', 'active'),
    ('fap015', '32', 'active'),
    ('fap028', '33', 'active'),
    ('fap035', '34', 'active'),
    ('fap040', '35', 'active'),
    ('fap009', '36', 'active'),
    ('fap013', '37', 'active'),
    ('fap017', '38', 'active'),
    ('fap022', '39', 'active'),
    ('fap029', '029', 'archived'),
    ('fap037', '037', 'archived');

update products as p
set num = mapped.num,
    status = mapped.status,
    updated_at = now()
from print_curation_map as mapped
where p.id = mapped.id
  and p.type = 'print';

do $$
declare
  active_count integer;
  active_number_count integer;
  mismatch_count integer;
begin
  select count(*), count(distinct num)
  into active_count, active_number_count
  from products
  where type = 'print' and status = 'active';

  if active_count <> 39 or active_number_count <> 39 then
    raise exception 'print curation expected 39 active rows and 39 unique numbers, got % and %',
      active_count, active_number_count;
  end if;

  if (select min(num) from products where type = 'print' and status = 'active') <> '01'
     or (select max(num) from products where type = 'print' and status = 'active') <> '39' then
    raise exception 'print curation expected active number range 01..39';
  end if;

  -- Exact per-ID verification, not just counts and range: every mapped row must
  -- exist as a print and carry exactly its mapped num and status (this also
  -- subsumes the fap029/fap037 archived check). A missing row, a swapped
  -- assignment, or a partially applied update aborts the transaction.
  select count(*) into mismatch_count
  from print_curation_map as expected
  left join products p on p.id = expected.id and p.type = 'print'
  where p.id is null
     or p.num is distinct from expected.num
     or p.status is distinct from expected.status;

  if mismatch_count <> 0 then
    raise exception 'print curation mismatch on % mapped product rows', mismatch_count;
  end if;
end
$$;

commit;
```

The migration must not update `order_items`, `fulfilment_jobs`, `prodigi_orders`, `pod_variants` (the Prodigi SKU catalogue — a different table from the catalog's `product_variants`), `product_media`, `print_fulfilment_assets`, `print_variant_asset_assignments`, or R2 keys.

The migration also deliberately does not touch `product_variants` (the catalog variants table): variant `active` flags converge through the seed's `active: d.published` behavior from Step 3, so running `npm run catalog:backfill` immediately after applying this migration is a REQUIRED rollout step (enforced in Task 5). Until the backfill runs, the archived products' variant rows remain `active = true` but dormant — archived products are excluded from every public read path — and the rollout must not stop in that intermediate state.

- [ ] **Step 5: Pin the migration snapshot to the JSON source**

Add a test to `src/lib/print-curation.test.ts` that parses the migration's `print_curation_map` VALUES block and compares it row-by-row — `(id, num, status)`, in order — against the projection derived from `config/print-catalog-curation.json` (active rows from `collections[].prints` with their `number`, then retired rows with their `sourceNumber` and `archived`). Because the DB update writes each row per-ID from that same verified list, a swapped or drifted assignment anywhere in the chain (JSON → migration → DB) fails `npm run test` before rollout, and the in-migration postcondition catches divergence at apply time:

```ts
const migration = readFileSync(
  new URL('../../supabase/migrations/20260828120000_curate_fine_art_prints.sql', import.meta.url),
  'utf8',
);
const valuesBlock = migration.match(
  /insert into print_curation_map \(id, num, status\)\s*values\s*([\s\S]*?);/,
);
const migrationRows = Array.from(
  valuesBlock![1].matchAll(/\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g),
  ([, id, num, status]) => ({ id, num, status }),
);
const authoredRows = [
  ...source.collections.flatMap(({ prints }) => prints.map(({ productId, number }) => ({
    id: productId, num: number, status: 'active',
  }))),
  ...source.retired.map(({ productId, sourceNumber }) => ({
    id: productId, num: sourceNumber, status: 'archived',
  })),
];
expect(migrationRows).toEqual(authoredRows);
```

- [ ] **Step 6: Run catalog and curation tests**

Run: `npx vitest run src/lib/print-curation.test.ts src/lib/catalog/catalog-parity.test.ts src/lib/catalog/catalog-read-parity.test.ts`

Expected: PASS with code and DB projections in the same active order, and the migration snapshot equal to the JSON projection.

- [ ] **Step 7: Run the local Supabase test suite if available**

Run: `supabase test db`

Expected: all pgTAP tests pass. If Docker/local Supabase is unavailable, record that limitation and do not claim the migration was executed.

- [ ] **Step 8: Commit the catalog projection**

```bash
git add src/lib/catalog/seed.ts src/lib/catalog/catalog-parity.test.ts src/lib/catalog/catalog-read-parity.test.ts src/lib/print-curation.test.ts supabase/migrations/20260828120000_curate_fine_art_prints.sql
git commit -m "feat: project print curation into catalog"
```

---

### Task 5: Verify the full application and document rollout

**Files:**
- Modify: `docs/STATUS.md`
- Modify: `docs/print-asset-runbook.md`

**Interfaces:**
- Consumes: completed code and migration from Tasks 1–4.
- Produces: verified rollout instructions and current catalog status.

- [ ] **Step 1: Update volatile status**

Change the Fine-art prints row in `docs/STATUS.md` to state that 39 designs are active, `fap029` and `fap037` are archived duplicates, nine fixed-name collections are live, stable `fapNNN` IDs remain unchanged, and the source of truth is `config/print-catalog-curation.json`. Use the actual verification date.

- [ ] **Step 2: Update runbook assumptions**

Document that source folders and operational IDs no longer equal display numbers. Commands continue to accept stable product IDs such as `fap041`; operators must consult the curation mapping when translating a storefront number back to a source folder/product ID. Retired assets remain retained for historical fulfilment.

- [ ] **Step 3: Run focused tests**

```bash
npx vitest run src/lib/print-curation.test.ts src/lib/prints.test.ts src/lib/print-collections.test.ts src/lib/cms/schemas.test.ts src/lib/cms/messages.test.ts src/lib/catalog/catalog-parity.test.ts src/lib/catalog/catalog-read-parity.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run the complete application checks**

```bash
npm run lint
npm run typecheck
npm run test
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 5: Verify the collection page in code mode**

Run the local app and inspect `/fine-art-prints` plus one non-Polish locale. Confirm:

- nine sections appear in the exact configured order;
- the names are byte-for-byte identical across locales;
- tiles are numbered `01`–`39` without gaps;
- no tile or PDP for `fap029` or `fap037` is publicly reachable;
- `fap041` renders as `Nº 13` under `Linea` while its URL remains `/fine-art-prints/fap041`;
- descriptions still belong to the correct stable design IDs.

- [ ] **Step 6: Apply and verify Supabase in staging**

Apply `20260828120000_curate_fine_art_prints.sql` to staging first, then run `npm run catalog:backfill` against staging — REQUIRED before any `CATALOG_SOURCE=db` verification, because the migration leaves `product_variants` untouched and the backfill is what converges archived designs' variants to `active = false`. Verify with:

```sql
select id, num, status
from products
where type = 'print'
order by case when status = 'active' then 0 else 1 end, num;

select count(*) as active_count,
       count(distinct num) as unique_active_numbers,
       min(num) as first_number,
       max(num) as last_number
from products
where type = 'print' and status = 'active';

select p.id, p.num, p.status,
       count(*) filter (where v.active) as active_variants
from products p
left join product_variants v on v.product_id = p.id
where p.type = 'print' and p.status = 'archived'
group by p.id, p.num, p.status;
```

Expected: `39 | 39 | 01 | 39`; the first query's output matches `config/print-catalog-curation.json` **row for row** on `(id, num, status)` — compare each ID's number against the mapping, not just the counts; the third query returns exactly `fap029 | 029 | archived | 0` and `fap037 | 037 | archived | 0` (archived designs keep their variant rows, all inactive).

- [ ] **Step 7: Verify DB catalog mode in staging**

Only after the Step 6 backfill has run, start the staging storefront with `CATALOG_SOURCE=db` and repeat the checks from Step 5. Confirm checkout resolution for one active print and historical/admin lookup for each archived stable ID.

- [ ] **Step 8: Apply the same migration to production**

Apply only after staging passes and after confirming the targeted Supabase project reference. Immediately run `npm run catalog:backfill` against production and re-run all three verification queries, including the archived-variant check. Do not delete old assets or run any R2 cleanup as part of this release.

- [ ] **Step 9: Commit documentation**

```bash
git add docs/STATUS.md docs/print-asset-runbook.md
git commit -m "docs: record print curation rollout"
```

---

## Self-Review Findings

- **Spec coverage:** exact names, locale independence, sequential two-digit numbers, both removals, nine 4–5-item collections, mapping-first workflow, code registry, Supabase, notes, assets, and verification each have an explicit task.
- **Identity safety:** stable IDs and `noteIndex` are explicitly preserved; no order, fulfilment, asset, URL, or cart rewrite is planned.
- **Single-source discipline:** collection membership and numbering are authored only in `config/print-catalog-curation.json`; TypeScript and SQL are projections. The SQL migration is an immutable rollout snapshot pinned row-by-row to the JSON by the Task 4 parity test, while future backfills continue to derive from the JSON-backed registry.
- **Known assumption requiring studio approval:** `fap041` moves from `Ciala` to `Linea` to keep every collection at four or five active prints after removing `fap029` and `fap037`.
