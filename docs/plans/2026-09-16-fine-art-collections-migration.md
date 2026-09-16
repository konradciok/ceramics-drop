# Fine-art-print collections: migrate to the CMS collections system

## Context

The new CMS (`cms-ceramics`) and its backend `collections`/`collection_drafts`
tables (migration `20260915120000_cms_api_collections.sql`, merged as part
of "Collections v1", PR #313) let an operator create/edit named collections
of products through a real UI, with drafts, publish, and history.

Separately, this repo has had a *different*, older mechanism for exactly
this concept — grouping fine-art-print products (`fap001`-`fap041`) into
named, ordered collections for the `/sklep` storefront page — since before
the CMS existed: a static, schema-validated file,
`config/print-catalog-curation.json`, read by `src/lib/print-curation.ts`
and `src/lib/print-collections.ts`. There are 9 collections today: Ostrea,
Gestures, Linea, Horizons, Portals, Signs, Ciala, Balance, Verticles (39
active prints total), plus 2 retired/archived prints (`fap029`, `fap037`)
tracked in the same file.

This plan migrates those 9 real, currently-live collections into the new
`collections` table, and switches `/sklep`'s rendering to read from there
instead of the JSON — so they become visible and editable in the CMS, and
CMS edits actually take effect on the live site.

**Why now:** the CMS's Collections feature (create/edit/publish/restore)
just shipped and was verified end-to-end against real data (cms-ceramics PR
#4). The static JSON has no operator-facing UI at all today — the only way
to change a collection is editing the file and deploying. This closes that
gap for real, already-live collections, not just newly-created ones.

**Out of scope:** archived-print status (`fap029`/`fap037`) is *already*
correctly `products.status = 'archived'` in production — confirmed
directly via SQL. Nothing needs to change there; this plan does not touch
archival/retirement at all, only the 9 active collections.

## Design

### 1. Architecture

`ceramics-drop`'s storefront and the `collections` table live in the same
Supabase database, in the same deployment — the storefront reads it
directly via `SupabaseClient`, the same way it already reads `products`. No
need to route storefront rendering through the CmsApi's HTTP layer.

Add a server-side loader (new function in `src/lib/print-collections.ts`,
or a new sibling module if that file gets too large) that:
- Queries `collections` joined to `collection_drafts` at
  `collections.published_revision` only — **never draft** state, matching
  the CMS's own draft/publish model and keeping unpublished edits
  invisible to customers, same as every other resource kind.
- Parses each collection's `fields` array (the `key: "products"`,
  `type: "productIds"` field — see Global Constraint 6 from the CMS wiring
  plan for the shape) into an ordered `string[]` of product ids.
- Reads the `key: "slug"` field (new — see backfill section) for a stable
  URL/anchor slug, and `name` for display.
- Returns the same shape `PRINT_COLLECTION_DEFINITIONS` provides today
  (`{slug, name, designIds}[]`), so `groupPrintDesigns()` and
  `printDisplayName()` in `print-curation.ts`/`print-collections.ts` keep
  their existing logic — only their data source changes.

### 2. The async/sync structural change

Today `PRINT_COLLECTION_DEFINITIONS`, `printDisplayName()`,
`curationForProduct()`, `catalogStatusForPrint()` are synchronous,
module-level constants/functions computed once at import time from the
static JSON. A DB-backed source is inherently per-request and async.

This is the largest real cost in this change: every current call site of
these functions needs to either become async itself, or the collections
data needs to be fetched once per request (e.g. in
`src/app/[locale]/(collections)/sklep/page.tsx`'s server component, which
already does async data loading via `getPrintDesigns()`) and threaded down
as a parameter to `groupPrintDesigns()`/`printDisplayName()` instead of
each reading a module constant independently. Prefer threading a parameter
over making every call site async — smaller diff, and these are pure
functions today; keeping them pure (data in, data out) is worth preserving
rather than turning them into async I/O-performing functions.

**Implementation must grep every current caller** of
`PRINT_COLLECTION_DEFINITIONS`, `printDisplayName`, `curationForProduct`,
`catalogStatusForPrint`, `groupPrintDesigns`, `collectionOf` before
changing signatures, so no call site is silently left calling stale
synchronous data.

### 3. Backfill (one-time script, run against real production)

New script, `scripts/backfill-fine-art-collections.ts`, modeled on the
existing `scripts/backfill-catalog.ts` CLI-script convention (tsx, run via
an `npm run` script entry).

For each of the 9 collections, **in the JSON's current order**, call the
real `create_collection_with_draft` RPC (not raw inserts — reuses the
already-tested atomic, id-collision-safe path the CmsApi itself uses) with:

```
name: <collection name, e.g. "Ostrea">
fields: [
  { key: "description", label: "Opis kolekcji", type: "text", value: "<name>.", locale: "pl", sourceLocale: "pl" },
  { key: "description", label: "Opis kolekcji", type: "text", value: "", locale: "en", sourceLocale: "pl" },
  { key: "description", label: "Opis kolekcji", type: "text", value: "", locale: "es", sourceLocale: "pl" },
  { key: "description", label: "Opis kolekcji", type: "text", value: "", locale: "de", sourceLocale: "pl" },
  { key: "products", label: "Produkty i kolejność", type: "productIds", value: "<CSV of productIds in JSON order>", locale: "none", sourceLocale: "none" },
  { key: "slug", label: "Slug", type: "text", value: "<the JSON's existing slug, e.g. \"ostrea\">", locale: "none", sourceLocale: "none" },
]
```

The PL description is an honest, minimal placeholder (the collection name
itself, e.g. `"Ostrea."`) — not real marketing copy. It exists only to
satisfy `publish_collection_revision`'s `missing_polish` check so the
collection can publish immediately; someone (Anna) writes real copy later,
through the CMS, same as any other edit.

Immediately after creating each collection (revision 1), call
`publish_collection_revision` for that same revision — so every collection
is born with `published_revision = 1`, through the same validated RPC path
the CMS itself uses (not a raw `UPDATE`), which also proves the
placeholder text is genuinely non-blank and every product id resolves
(the RPC's `product_ref_invalid` check).

**Sequencing — this is the part that avoids any visible gap:**
1. Run the backfill against production first. `/sklep` is still running
   the *old* code (reading the JSON) at this point — nothing changes yet.
2. Deploy the code change (section 1-2) second. The moment it's live, it
   finds the already-backfilled, already-published data and renders
   identically to before.

**Idempotency:** this is a single careful one-time run, not a repeatable
operation (collections have no delete API — see Global Constraint from the
original collections migration). Before creating each collection, the
script queries `collection_drafts` for an existing row whose
`payload->>'name'` matches that collection's name, and skips creation
(logging that it skipped) if found — so a re-run after a partial failure
does not create duplicates.

### 4. Testing / verification

- Unit-test the new loader against fake `collections`/`collection_drafts`
  rows (mirroring the existing `collections-mapping.test.ts` patterns) —
  confirm it correctly filters to `published_revision`, parses the
  `productIds` CSV, and produces the same shape `groupPrintDesigns()`
  expects.
- After the backfill runs, verify directly via SQL: all 9 collections have
  `published_revision = 1`, and each one's `productIds` field matches the
  JSON's product list exactly (same ids, same order).
- After the code deploys, load `/sklep` in a real browser and confirm it
  is visually and structurally identical to before the change — same 9
  section headings in the same order, same products in the same order
  within each, same print numbering (Ostrea 01, Ostrea 02, …).

### 5. Rollback

- **Code rollback** is independent of the data: redeploy the previous
  Cloudflare Worker version (Cloudflare retains version history; every
  `wrangler deploy` this session has printed a `Current Version ID`,
  confirming versioned rollback is available). Backfilled rows remain in
  the DB but are inert under the old code — nothing reads `collections` —
  so a code-only rollback is clean and low-risk.
- **Bad data** (wrong product, wrong order) is fixable the normal way —
  through the CMS itself (new draft revision, fix, publish) — or, only in
  a genuine emergency, direct SQL. No exotic recovery mechanism needed.

### 6. Cleanup

Once the code change is live and verified: delete
`config/print-catalog-curation.json` and the now-dead exports in
`print-curation.ts` (`validatePrintCuration`, `PRINT_CURATION`,
`ACTIVE_PRINT_CURATION`, and anything else with no remaining caller) —
**grep for every export first**; `RETIRED_PRINT_CURATION` /
`curationForProduct`'s retired-lookup behavior may still be relied on
elsewhere for archived-print handling even though the *collections* half
of this file is being replaced — confirm before removing, don't assume.

## Non-goals

- No change to archived/retired print status or logic (already correct).
- No change to how products are created, saved, or otherwise managed.
- No change to the CMS (`cms-ceramics`) itself — once real data exists in
  `collections`, it is visible/editable there with zero CMS-side code
  changes, since the Collections feature is already generic.
- No attempt to rebuild `validatePrintCuration`'s build-time integrity
  guarantees (exactly 9 collections, exactly 41 product ids, no orphans)
  as a runtime check. Worth a follow-up if this becomes a real operational
  problem, but out of scope here (YAGNI) — flag, don't build, until it's
  actually needed.
