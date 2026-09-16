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

**Confirmed full caller list** (grepped against `origin/main`, non-test):
`printDisplayName` is called from 15 files spanning several *different*
execution contexts, not just page renders — `sklep/page.tsx`,
`(pdp)/[slug]/[id]/page.tsx`, `[locale]/page.tsx` (homepage),
`seo/structured-data.ts` (page metadata — server, request-scoped);
`components/shop/CartView.tsx`, `PrintCollectionScreen.tsx`,
`PrintProductScreen.tsx` (need to confirm client vs. server per
component); `lib/invoice.ts` (order invoice generation — background/
webhook context, its own lifecycle); `lib/analytics.ts`,
`lib/marketing/conversions.ts` (event/webhook-triggered, not request-scoped
in the page sense); `lib/feed.ts` (product feed generation — cron/on-demand,
its own lifecycle); `lib/account/items.ts` (order-history rendering);
`lib/admin/content.ts`, `lib/admin/products.ts` (admin listings).
`catalogStatusForPrint` is additionally called from `lib/catalog/seed.ts`.
`curationForProduct` from `lib/prints.ts`.

**This is a materially bigger change than "swap one page's data source."**
Given the real blast radius (client components, webhooks, cron jobs, admin
— each a different data-loading lifecycle), this work is split into two
plans:

- **Plan 1 (this plan's implementation target):** the loader, the
  backfill, and the storefront-facing consumers that already do
  per-request async data loading and together cover what a customer
  actually sees browsing the site: `src/app/[locale]/(collections)/sklep/page.tsx`
  and `src/components/shop/PrintCollectionScreen.tsx` (the collection
  listing — the actual grouping/rendering happens in the screen component,
  not the page file), `src/app/[locale]/(pdp)/[slug]/[id]/page.tsx` and
  `src/components/shop/PrintProductScreen.tsx` (the PDP — same split),
  `src/app/[locale]/page.tsx` (homepage), and `src/lib/seo/structured-data.ts`
  (`printCollectionSchema`/`printProductSchema`, both already take a
  pre-fetched `designs`/`design` argument from their callers, so they just
  need the same new optional parameter, not a data-loading change).
- **Plan 2 (separate, scoped later, after Plan 1 ships and is verified
  live — now fully investigated and planned, see
  `docs/superpowers/plans/2026-09-16-fine-art-collections-plan2.md`):**
  `CartView.tsx` + `cart-lines-server.ts` (the cart's actual data
  resolution is server-side; CartView reads a pre-resolved name, no
  client DB access needed), `invoice.ts`, `analytics.ts` +
  `PrintCollectionAnalytics.tsx` + `PrintViewAnalytics.tsx` +
  `PrintConfigurator.tsx` + `PrintPdpPurchase.tsx` (client-side GA4/Meta
  tracking — each of these components already receives or can receive
  `definitions`/a resolved name from its Plan-1-updated parent, one to two
  hops away), `marketing/conversions.ts`, `feed.ts`, `admin/content.ts`,
  `admin/products.ts`, `account/items.ts`. `catalog/seed.ts` was
  investigated and confirmed genuinely out of scope for both plans — its
  only relevant call is `catalogStatusForPrint`, already excluded.
  `AddToCartButton.tsx`, `Gallery.tsx`, `ProductTile.tsx` were initially
  suspected in scope but confirmed ceramics-only — no print-naming
  dependency at all, need no changes.

Plan 1 leaves Plan 2's call sites reading the OLD static JSON/exports
unchanged and working exactly as today — this plan does not delete
`config/print-catalog-curation.json` or `print-curation.ts`'s exports yet
(see the Cleanup section: cleanup only happens once *all* callers are
migrated, i.e. after Plan 2).

**Additional scope boundary, also out of Plan 1 (and Plan 2):**
`curationForProduct()` (`print-curation.ts`, called from `prints.ts:504`)
drives a THIRD thing beyond naming and grouping — whether a print is
`published` (shown/orderable) at all — and `prints.ts`'s `getPrintDesigns()`
is what every page (including Plan 1's four) calls to get its design list
in the first place. Plan 1 does **not** touch this: `published` stays
governed by the static JSON, unchanged, same as the already-agreed
archived-status boundary. Consequence: after Plan 1, editing a collection
through the CMS can rename a print or move it between sections, but
cannot make a wholly new print appear or an existing one disappear from
the site — that still requires editing the JSON and deploying, same as
today. Revisiting `published`'s source is explicitly out of scope for both
plans; flag as a future follow-up if it becomes a real need.

**Signature design (why Plan 2 callers need zero changes):**
`printDisplayName(design, fallback)` and `groupPrintDesigns(designs)` gain
a new, optional, backward-compatible third/second parameter —
`definitions: PrintCollectionDefinition[]` — defaulting to the existing
module-level `PRINT_COLLECTION_DEFINITIONS`/`PRINT_COLLECTIONS` constants
(the static JSON, exactly as today). Plan 1's four files pass their
DB-loaded definitions explicitly; every other caller (Plan 2's nine files)
needs no code change at all — it keeps calling the same function the same
way and gets the same static-JSON-backed behavior it does today.

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

### 6. Cleanup (Plan 2's final task, not Plan 1)

`config/print-catalog-curation.json` and `print-curation.ts`'s exports
stay in place and in use after Plan 1 — Plan 2's callers still read them.
Cleanup (deleting the JSON file and any exports left with no caller) is
Plan 2's own final task, once every caller has migrated. Do not delete
anything from `print-curation.ts` as part of Plan 1.

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
