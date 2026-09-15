# Collections v1 — ceramics-drop backend (S2 continuation)

## Spec / authority

The binding spec is `cms-ceramics/docs/plans/2026-09-09-cms-v1.md` §3 (S2 milestone:
Collections + mockups-as-data). This plan implements Collections only. It is the
**backend half** of a two-repo change; a follow-up plan
(`cms-ceramics/docs/plans/2026-09-15-collections-v1-cms-wiring.md`) wires the
cms-ceramics admin UI to these endpoints once this plan's PR is merged and a live
acceptance pass against `ceramics-drop-preview` has been run (see "Sequencing" below).

Contract file `contracts/cms-v1.json` is the source of truth for the wire shape.
Confirmed directly against the current file (2026-09-15): `/v1/collections/{id}`
already has `get`+`put`, `.../publication` already has `post`, `.../restore` already
has `post` — all contract-complete today. The **only** gap is `POST /v1/collections`
(create) and a `ResourceCreate` schema. Do not re-litigate the already-complete
endpoints' shapes; Task 2 only adds the create operation.

## Scope

In scope: migration (2 new tables + `catalog_audit_log` alteration + 4 RPCs),
contract's `POST /v1/collections`, six new CmsApi routes, tests, docs.

Out of scope (do not build): a public storefront page grouping products by
collection; `DELETE /v1/collections/{id}` (collections have no
status/hide/archive concept — an unwanted collection is emptied and left
unpublished); any cms-ceramics change (separate plan/PR).

## Global Constraints

These bind every task below. When a task's own text and this section conflict,
this section wins (it was written after deeper verification than the task
prose). When source code and this section conflict, **read the actual source
file** — this section describes patterns from a snapshot; exact syntax lives
in the code.

1. **Do not bump `contracts/cms-v1.json`'s `info.version`** (currently
   `"1.0.0"`). cms-ceramics' `gateway.ts` compares `contractVersion` by exact
   string equality; a bump 409s every existing CMS write, not just
   collections, until both repos redeploy in lockstep. This change is purely
   additive.
2. **`ResourceSave` body shape is `{expectedRevision, name, fields}`** — NOT
   `{expectedRevision, draft}` like products. `save_collection_draft`'s
   `p_payload` and the row's stored payload are the `{name, fields}` object
   directly (no wrapper key).
3. **`Field` schema** (verbatim from contract, all 6 keys required,
   `additionalProperties:false`): `{key: string, label: string, type: enum[
   text, richtext, number, productIds], value: string, locale: enum[pl, en,
   es, de, none], sourceLocale: enum[pl, en, es, de, none]}`.
4. **`Resource` schema** (verbatim, all required, `additionalProperties:
   false`): `{id, kind: enum[...,"collections",...], name, revision,
   publishedRevision: int|null, fields: Field[]}`.
5. **`GET /v1/collections` has no query params and no pagination** — contract
   response is `ResourceList = {items: Resource[]}`, no `total`/`page`/
   `pageSize`. `collections-list.ts` must return **every** collection
   unfiltered, unsorted, unpaginated. Do NOT mirror `products-list.ts`'s
   query/filter/sort logic — that's a different, larger contract shape.
6. **No DELETE endpoint, no status field, no version bump.**
7. **RPC naming**: `create_collection_with_draft`, `save_collection_draft`,
   `publish_collection_revision`, `restore_collection_draft`. Each
   `language plpgsql`, `set search_path = public, pg_temp`, followed by
   `revoke all ... from public, anon, authenticated;` +
   `grant execute ... to service_role;` — copy the exact grant/revoke
   statements used after `save_product_draft` in
   `supabase/migrations/20260912120000_cms_api_products.sql`.
8. **Revision-conflict convention** (copy the exact pattern from
   `save_product_draft` in the same migration, substituting
   `collection_drafts`/`p_collection_id`): compute
   `v_current_revision := coalesce(max(revision), 0)` from
   `collection_drafts where collection_id = p_collection_id`; if it doesn't
   equal `p_expected_revision`, raise `'revision_conflict'` with a detail
   string the handler layer parses as `currentRevision=<n>` (reuse or
   replicate `products-save.ts`'s `extractCurrentRevision` regex helper:
   `/currentRevision=(\d+)/` against `error.message + error.details`).
9. **`draft_required`**: `publish_collection_revision` raises it when
   `p_expected_revision = 0` (i.e. no draft was ever saved — collection_drafts
   starts at revision 1, same convention as products). This check sits
   alongside, not instead of, the revision-conflict check above.
10. **`missing_polish`** (new error condition, no product precedent):
    `publish_collection_revision` raises it when the current draft's
    `payload->'fields'` contains a field with `locale = 'pl'` whose `value`
    is blank after trimming, OR contains no `pl` field at all. Iterate with
    `jsonb_array_elements`.
11. **`product_ref_invalid`** (new error condition, no product precedent):
    `publish_collection_revision` raises it when the `productIds`-type
    field's CSV `value` contains any id that doesn't exist in `products`.
    `products.id` is `text primary key` with **no format CHECK** — an
    `exists(select 1 from products where id = <token>)` check per non-blank,
    trimmed CSV token is sufficient. An empty CSV (no products in the
    collection) is valid, not an error. **Detail-string format is pinned
    here** (Task 1 implements it, Task 7 parses it — do not redecide it in
    either task): `raise exception 'product_ref_invalid' using detail =
    format('invalidIds=%s', array_to_string(v_invalid_ids, ','));` — mirrors
    the existing `currentRevision=%s` convention. The handler parses via
    `/invalidIds=(.*)$/` against `error.message + error.details` and splits
    the captured group on `,` to build `fieldErrors.products`.
12. **Audit actions for collections** (no product precedent for these exact
    strings — this is a plan-writing decision, apply it as binding): use
    `'draft_saved'` for both create and save, `'published'` for publish,
    `'restored'` for restore. `catalog_audit_log.collection_id` scopes the
    row; `product_id` stays null on these rows (and vice versa on existing
    product rows) per the new `num_nonnulls` check.
13. **`catalog_audit_log` current shape** (verbatim from
    `supabase/migrations/20260710120000_catalog_audit_log.sql` — read it in
    full before touching it): `id uuid primary key default gen_random_uuid(),
    product_id text not null, actor_email text, action text not null, before
    jsonb, after jsonb, created_at timestamptz default now()`, index
    `catalog_audit_log_product_idx(product_id, created_at desc)`, RLS
    enabled with no policies (service-role only). `product_id` is
    deliberately **not** an FK (existing comment: audit rows must survive id
    removal) — `collection_id` must follow the same non-FK convention.
    `revision integer` was added later by
    `supabase/migrations/20260912120000_cms_api_products.sql` — it already
    exists, do not re-add it.
14. **Circular-FK ordering inside the new migration**: `collections` and
    `collection_drafts` are both new in this one file, and each needs the
    other to exist first (`collection_drafts.collection_id` references
    `collections(id)`; `collections.published_revision` composite-FKs to
    `collection_drafts(collection_id, revision)`). Mirror how products
    resolved this across two migrations, but within one file: (a) `create
    table collections` WITHOUT `published_revision` yet; (b) `create table
    collection_drafts` (FK to `collections(id) on delete cascade`, `unique
    (collection_id, revision)`); (c) supporting index
    `collection_drafts_collection_idx(collection_id, revision desc)`; (d)
    `alter table collections add column published_revision integer`; (e)
    `alter table collections add constraint
    collections_published_revision_fk foreign key (id, published_revision)
    references collection_drafts(collection_id, revision)`.
15. **Idempotency**: `src/server/cms-api/idempotency.ts` is fully generic
    (`claimIdempotencyKey`/`completeIdempotencyKey`/`releaseIdempotencyKey`,
    keyed by `(operation, idempotencyKey)`) — reuse verbatim, no schema
    change. New `operation` strings: `'collections:create'`,
    `'collections:publication'`, `'collections:restore'`. 422 shape for a
    missing header (copy exactly from `products-create.ts`):
    `errorResponse('IDEMPOTENCY_REQUIRED', 'Idempotency-Key header is
    required.', 422, ctx.requestId)`. Claim happens **before** body
    validation (a validation failure after claiming still calls
    `releaseIdempotencyKey` — copy this ordering from `products-create.ts`).
16. **Collection id format**: `col_${crypto.randomUUID().replace(/-/g,
    '').slice(0,10)}`, with the same 3-attempt Postgres `23505`
    (unique_violation) retry loop as `generateProductId()` in
    `products-create.ts`.
17. **Error-code → HTTP mapping**: `*_not_found` → 404 `NOT_FOUND`;
    `revision_conflict` → 409 `REVISION_CONFLICT` (with `currentRevision`);
    `draft_required` → 422 `VALIDATION_FAILED`; `missing_polish` → 422
    `MISSING_POLISH` (new code, added to the contract's `Error.code`
    description in Task 2); `product_ref_invalid` → 422 `VALIDATION_FAILED`
    with `fieldErrors: {products: [<invalid ids>]}` (parsed from the
    `invalidIds=%s` detail string pinned in constraint 11 — do not invent a
    different format in the handler);
    `source_revision_not_found` → 404 `NOT_FOUND`.
18. **Collections mapping/validation is greenfield** — there is no existing
    generic `Field[]`/`Resource`-shaped handler anywhere in this backend
    today (`ProductResponse`/`ProductDraft` are ceramics-specific unions).
    Design `collections-mapping.ts`/`collections-validation.ts` fresh
    against the `Field`/`Resource` contract shapes in items 3-4 above — the
    shape must match cms-ceramics' mock server
    (`cms-ceramics/src/lib/mock/store.ts`) exactly, since that mock is the
    CMS's local-dev parity target and the eventual live-acceptance
    comparison point.
19. **`restore_collection_draft` has zero backend precedent** — no `restore_*`
    RPC exists anywhere in this repo (verified by grep across all
    migrations). Design it directly from the `Restore` contract schema
    (`{expectedRevision, sourceRevision}`) and
    `docs/cms-api-data-model.md`'s existing line: *"Nothing is ever deleted
    or rewritten here: 'restore' (a future op) would re-save an old payload
    as a new revision."* It copies `collection_drafts` row at
    `p_source_revision`'s payload into a **brand-new** revision (current
    max + 1); it must **never** touch `collections.published_revision`. If
    `p_source_revision` doesn't exist for this collection, raise
    `'source_revision_not_found'`.
20. **Router**: `src/server/cms-api/request-handler.ts` has a `routes:
    RouteDef[]` array with the comment "Later tasks append their RouteDef
    exports to this array. Keep it a plain array literal (not a function) so
    each task's diff is a one-line addition." `RouteDef = {method, path,
    handler}`; `RouteHandler = (req, env, params, ctx) =>
    Promise<Response>`. Six routes needed: `GET /v1/collections` (list),
    `GET /v1/collections/{id}` (get), `POST /v1/collections` (create), `PUT
    /v1/collections/{id}` (save), `POST /v1/collections/{id}/publication`
    (publish), `POST /v1/collections/{id}/restore` (restore). There is no
    publication-readiness GET equivalent for collections (no blockers
    concept) — only the POST.
21. **Reuse as-is, do not reinvent**: `jsonResponse`/`errorResponse`/
    `newRequestId` from `http.ts`; the idempotency dance from
    `idempotency.ts`; the `extractCurrentRevision` regex-parsing pattern
    from `products-save.ts`.
22. **File organization**: one file per operation under
    `src/server/cms-api/`, mirroring the products split exactly:
    `collections-mapping.ts`, `collections-validation.ts`, additions to
    `types.ts` (a `Field` type + `CollectionResponse` type),
    `handlers/collections-list.ts`, `handlers/collections-get.ts`,
    `handlers/collections-create.ts`, `handlers/collections-save.ts`,
    `handlers/collections-publication.ts`, `handlers/collections-restore.ts`.
23. **Verification bar for the migration/pgTAP task specifically**: the
    `supabase` CLI is not on PATH by default in this environment, but `npx
    supabase <cmd>` works (confirmed: `npx supabase --version` → 2.117.0).
    Docker Desktop was being started at plan-authoring time — check `docker
    ps` when this task runs. If Docker is available, the implementer MUST
    run `npx supabase test db` (or the project's real equivalent — check
    `supabase/config.toml` and any CI workflow for the exact invocation) and
    report real output. If Docker is genuinely unavailable in this
    environment, the implementer must say so explicitly in the report (never
    claim "tests pass" without real command output) and instead do an
    exhaustive line-by-line manual review of the SQL against every existing
    RPC it mirrors, documenting that review in the report. The task
    reviewer must independently re-verify SQL correctness by reading, not
    by trusting the implementer's claim.
24. **Standard commands**: `npm run lint && npm run typecheck && npm run
    test` (per this repo's `CLAUDE.md`) before any task is reported done.
25. **Migration filename**: `supabase/migrations/20260915120000_cms_api_
    collections.sql` (confirmed next-chronological after
    `20260914140000_backfill_cms_ownership_guard.sql`, no collision).
    pgTAP companion: `supabase/tests/cms_api_collections.sql`, structured
    like `supabase/tests/cms_api_products.sql` (`begin; set local
    search_path to extensions, public, pg_temp; select plan(<n>); ...
    select * from finish(); rollback;`, `throws_ok`/`throws_like`,
    `has_function_privilege` checks for `anon`/`service_role` on every new
    RPC).
26. **Rollback block**: every migration in this repo ends with a commented
    manual rollback block. Mirror `20260912120000_cms_api_products.sql`'s
    ordering (drop in reverse-dependency order): drop the 4 functions, drop
    `catalog_audit_log`'s new constraint/column, restore
    `catalog_audit_log.product_id` to `not null`, drop
    `collections_published_revision_fk` + `collections.published_revision`,
    drop `collection_drafts`, drop `collections`.

---

# Task 1: Migration — collections schema, RPCs, and pgTAP tests

Create `supabase/migrations/20260915120000_cms_api_collections.sql`.

Before writing anything, read in full:
- `supabase/migrations/20260710120000_catalog_audit_log.sql` (table you're altering)
- `supabase/migrations/20260912120000_cms_api_products.sql` (the RPC/migration
  pattern you're mirroring — `product_drafts`, `products.published_revision`,
  `create_product_with_draft`, `save_product_draft`, `publish_product_revision`,
  the grant/revoke convention, the rollback block)
- `supabase/tests/cms_api_products.sql` (pgTAP structure to mirror)
- `docs/cms-api-data-model.md` (background; the restore-intent line is relevant)

Apply Global Constraints items 7-14, 16-19, 23, 25, 26 above. In summary, build:

1. `collections` table and `collection_drafts` table, created in the FK order
   given in constraint 14.
2. Alter `catalog_audit_log`: drop `product_id` NOT NULL, add nullable
   `collection_id text`, add `check (num_nonnulls(product_id, collection_id)
   = 1)`, add a partial index on `collection_id` mirroring the existing
   `product_id` index shape.
3. Four RPCs: `create_collection_with_draft(p_id text, p_payload jsonb,
   p_actor_email text) returns collection_drafts`, `save_collection_draft
   (p_collection_id text, p_expected_revision integer, p_payload jsonb,
   p_actor_email text) returns collection_drafts`,
   `publish_collection_revision(p_collection_id text, p_expected_revision
   integer, p_actor_email text) returns jsonb`, `restore_collection_draft
   (p_collection_id text, p_expected_revision integer, p_source_revision
   integer, p_actor_email text) returns collection_drafts`. Exact validation
   rules and audit actions are in Global Constraints 9-12, 19.
4. The manual rollback block (constraint 26).
5. Companion `supabase/tests/cms_api_collections.sql` covering: each RPC's
   success path; every `throws_ok`/`throws_like` error path named in
   constraints 9-11, 17, 19 (`revision_conflict`, `draft_required`,
   `missing_polish`, `product_ref_invalid`, `source_revision_not_found`,
   `collection_not_found`); `has_function_privilege` checks (anon denied,
   service_role allowed) for all 4 new functions; and a regression check
   that re-runs `create_product_with_draft`/`save_product_draft` after your
   `catalog_audit_log` change to prove the relaxed constraint didn't break
   the existing product-audit write path.

Run `npm run lint && npm run typecheck` (the migration itself isn't
TypeScript, but nothing else in the repo should break). Follow Global
Constraint 23's verification bar exactly — check `docker ps` yourself before
claiming any pgTAP result.

Report DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED per the standard
contract, and state explicitly in the report whether `npx supabase test db`
actually ran and passed, or whether you fell back to manual review (and why).

---

# Task 2: Contract — add `POST /v1/collections`

Edit `contracts/cms-v1.json` only. Read the file in full first — the
`/v1/collections/{id}`, `.../publication`, `.../restore` paths and the
`Resource`/`ResourceSave`/`Revision`/`Restore`/`Field` schemas already exist
and are correct; do not modify them.

Changes:
1. Add a new schema `ResourceCreate: { name: string }`, `required: ["name"]`,
   `additionalProperties: false`.
2. Add a `post` operation on the existing `/v1/collections` path object
   (which today has only `get`): requires an `Idempotency-Key` header
   parameter (mirror how other idempotent POSTs declare this header in this
   same file — e.g. `/v1/products`'s `post`), request body `ResourceCreate`,
   response `Resource` (reuse the existing schema).
3. Extend `Error.code`'s description string to add `MISSING_POLISH` to the
   list of known values (see Global Constraint 17 for where it maps).
4. Update `info.description` to remove "collections" from the "S2/S3/S4 — 404
   until implemented" list (read the current sentence carefully; the S3
   items — assets/uploads/jobs — and content/pricing/shipping-rates stay in
   that list; only collections comes out).
5. Do **not** touch `info.version` (Global Constraint 1).

Validate the JSON is well-formed (`node -e "JSON.parse(require('fs').
readFileSync('contracts/cms-v1.json','utf8'))"` or equivalent) and run
`npm run lint && npm run typecheck && npm run test`.

---

# Task 3: Collections mapping, validation, and shared types

Depends on Task 1 (RPC/table shapes) and Task 2 (contract schemas) landing
first. Create `src/server/cms-api/collections-mapping.ts` and
`src/server/cms-api/collections-validation.ts`; extend
`src/server/cms-api/types.ts`.

Before writing, read in full: `src/server/cms-api/mapping.ts`,
`src/server/cms-api/validation.ts`, `src/server/cms-api/types.ts` — for
**structural** conventions only (file organization, error-handling style,
how Supabase client errors surface, exported function naming) — per Global
Constraint 18, do **not** assume a 1:1 field-shape mirror; products' types
are ceramics-specific and collections' `Field[]`/`Resource` shape is new.
Also read `cms-ceramics/src/lib/mock/store.ts` and
`cms-ceramics/src/lib/api/schema.d.ts` (or the contract schemas directly, per
Global Constraints 3-4) so the shape you build matches the CMS's local-dev
mock exactly.

Build:
1. `types.ts` additions: a `Field` type matching Global Constraint 3
   verbatim, and a `CollectionResponse` type matching the `Resource` schema
   (Global Constraint 4) with `id`, `kind: "collections"`, `name`,
   `revision`, `publishedRevision: number | null`, `fields: Field[]`.
2. `collections-mapping.ts`: `loadCollectionResponse(supabase, id):
   Promise<CollectionResponse | null>` and `loadCollectionResponses
   (supabase, ids: string[]): Promise<Map<string, CollectionResponse>>` (or
   whatever plural-batching shape `mapping.ts`'s `loadProductResponses`
   uses — mirror that function's *shape*, not its ceramics-specific body).
   These read the `collections` row joined with its current
   `collection_drafts` row (the one at `revision = max(revision)` for that
   collection — i.e. the latest draft, which may be ahead of
   `published_revision`) and map `payload.name`/`payload.fields` into the
   response. `publishedRevision` comes from `collections.published_revision`
   (nullable).
3. `collections-validation.ts`: Zod schemas for `ResourceCreate` (`{name:
   string}`) and `ResourceSave` (`{expectedRevision: number, name: string,
   fields: Field[]}` — Global Constraint 2), plus `validateCollectionCreate`
   and `validateCollectionSave` functions mirroring `validation.ts`'s
   `validateProductDraft` error-reporting shape (so handler-layer 422
   responses look the same as products').

Write a focused unit test file (e.g. `collections-mapping.test.ts`,
`collections-validation.test.ts`) covering the mapping/validation logic
directly, independent of any HTTP handler (those come in later tasks).

Run `npm run lint && npm run typecheck && npm run test`.

---

# Task 4: `collections-list` and `collections-get` handlers

Depends on Task 3. Create `src/server/cms-api/handlers/collections-list.ts`
and `src/server/cms-api/handlers/collections-get.ts`.

Read `src/server/cms-api/handlers/products-get.ts` in full and mirror its
*get* pattern exactly (`loadCollectionResponse` → 404 `NOT_FOUND` or
`jsonResponse`). For list, read `src/server/cms-api/handlers/products-list.ts`
only to see the file's request/response plumbing (how it reads query
params, builds the response) — per Global Constraint 5, do **NOT** port its
pagination/filter/sort logic. `collections-list.ts` must `select` every row
from `collections`, map each via `collections-mapping.ts`, and return
`jsonResponse({items: [...]})` with no `total`/`page`/`pageSize` and no
query-param handling at all.

Write `collections-list.test.ts` and `collections-get.test.ts` mirroring the
mocked-RPC/mocked-Supabase style of `src/server/cms-api/handlers/
products-save.test.ts` (adapted — list/get don't call an RPC, they query
directly; mock the Supabase client call instead).

Run `npm run lint && npm run typecheck && npm run test`.

---

# Task 5: `collections-create` handler

Depends on Tasks 1, 3. Create `src/server/cms-api/handlers/
collections-create.ts` and its test file.

Read `src/server/cms-api/handlers/products-create.ts` in full and mirror its
structure exactly: idempotency claim first (operation string
`'collections:create'`, 422 `IDEMPOTENCY_REQUIRED` if the header is missing —
Global Constraint 15), THEN validate the body via
`validateCollectionCreate` (a validation failure after claiming still
releases the key — same ordering as products), generate a `col_<10-hex>` id
with the same 3-attempt `23505`-retry loop as `generateProductId()` (Global
Constraint 16), seed the default payload — Global Constraint 3's `Field`
shape, five fields: four locale description fields
(`locale: "pl"|"en"|"es"|"de"`, `type: "text"`, empty `value`) plus one
`productIds`-type field with `locale: "none"` and empty `value` — call
`create_collection_with_draft` inside the claim/complete/release dance, then
`loadCollectionResponse` to build the HTTP response.

Write `collections-create.test.ts` mirroring `products-create.test.ts`'s
mocked-RPC style, including an idempotency-replay test case (same key + same
body → same id, no second RPC call) and a key-reuse test case (same key +
different body → 409/`IDEMPOTENCY_KEY_REUSE`, whatever the existing
idempotency layer's exact status/code is — check `idempotency.ts` for it).

Run `npm run lint && npm run typecheck && npm run test`.

---

# Task 6: `collections-save` handler

Depends on Tasks 1, 3. Create `src/server/cms-api/handlers/
collections-save.ts` and its test file.

Read `src/server/cms-api/handlers/products-save.ts` in full and mirror its
structure — **except** the request body shape: parse `{expectedRevision,
name, fields}` (Global Constraint 2), not `{expectedRevision, draft}`. Call
`save_collection_draft` with `p_payload := jsonb_build_object('name', ...,
'fields', ...)` (construct this object shape server-side, matching whatever
shape `collections-mapping.ts` expects to read back). Map errors per Global
Constraint 17: `collection_not_found` → 404, `revision_conflict` → 409 (with
`currentRevision`, via the same `extractCurrentRevision` pattern).

Write `collections-save.test.ts` mirroring `products-save.test.ts`'s
mocked-RPC style (success path, 404, 409-with-currentRevision).

Run `npm run lint && npm run typecheck && npm run test`.

---

# Task 7: `collections-publication` handler

Highest-risk handler in this plan — most reviewer scrutiny should land here.
Depends on Tasks 1, 3. Create `src/server/cms-api/handlers/
collections-publication.ts` and its test file.

Read `src/server/cms-api/handlers/publication.ts` in full (the
`publicationPostRoute` function specifically) and mirror its structure
exactly: idempotency claim first (operation string
`'collections:publication'`), body is bare `{expectedRevision}` (no `action`
field — collections have no status states), call `publish_collection_revision`,
on RPC error `releaseIdempotencyKey` then map errors per Global Constraint 17
(`collection_not_found` → 404, `revision_conflict` → 409,
`draft_required` → 422 `VALIDATION_FAILED`, `missing_polish` → 422
`MISSING_POLISH`, `product_ref_invalid` → 422 `VALIDATION_FAILED` with
`fieldErrors: {products: [...]}` — parsed from the `invalidIds=%s` detail
string pinned in Global Constraint 11 (Task 1 already implements this exact
format; read Task 1's actual RPC code for the literal regex to mirror rather
than inventing a new format here), on success re-fetch via
`loadCollectionResponse` (same re-fetch-after-mutate pattern
`publication.ts` uses for products) then `completeIdempotencyKey`. Preserve
the try/catch-swallows-release-failure nuance `publication.ts` has (comment
there explains why: the original error must propagate; a stale lease
self-heals via `LEASE_MS`).

There is no publication-readiness GET equivalent for collections (Global
Constraint 20) — only write the POST handler.

Write `collections-publication.test.ts` covering: success (with re-fetch
assertion), `collection_not_found`, `revision_conflict`,
`draft_required`, `missing_polish`, `product_ref_invalid` (assert the
`fieldErrors.products` shape), and an idempotent-replay case.

Run `npm run lint && npm run typecheck && npm run test`.

---

# Task 8: `collections-restore` handler

Depends on Tasks 1, 3. Create `src/server/cms-api/handlers/
collections-restore.ts` and its test file. Per Global Constraint 19, there is
no existing restore handler anywhere in this repo to mirror structurally —
base the handler's *shape* (idempotency dance, error mapping, re-fetch
pattern) on `publication.ts`, since restore is also an idempotent POST that
mutates and re-fetches, but the body and RPC are per Global Constraint 19.

Body: `{expectedRevision, sourceRevision}` (the `Restore` schema — already
contract-complete, read it in `contracts/cms-v1.json`). Idempotency operation
string `'collections:restore'`. Call `restore_collection_draft`. Map errors:
`source_revision_not_found` → 404 `NOT_FOUND`, `revision_conflict` → 409,
`collection_not_found` → 404. On success, re-fetch via
`loadCollectionResponse` (the restored collection is now at the new revision
— unpublished, since restore never touches `published_revision` per
constraint 19) and return it.

Write `collections-restore.test.ts` covering success (assert the returned
revision is `expectedRevision + 1` and `publishedRevision` is unchanged),
`source_revision_not_found`, `revision_conflict`, `collection_not_found`.

Run `npm run lint && npm run typecheck && npm run test`.

---

# Task 9: Router registration, stale-test repoint, docs, end-to-end test

Depends on Tasks 4-8 (all six handlers must exist). Four changes in one task
because they're small and interdependent:

1. **Router**: in `src/server/cms-api/request-handler.ts`, add the 6 imports
   and 6 `RouteDef` entries at the "Later tasks append their RouteDef
   exports to this array" comment (Global Constraint 20 has the exact
   method/path list).
2. **Stale test**: `src/server/cms-api/request-handler.test.ts` around lines
   127-132 currently asserts `GET /v1/collections` 404s as proof of the
   S2/S3/S4 fallback (exact current text: a test titled `'404s an
   unregistered S2/S3/S4 path even carrying a fully valid owner token'`
   hitting `/v1/collections`). Repoint it at `/v1/content` (still
   unimplemented, same fallback family) — read the current test first to
   confirm your repointed version still asserts the same thing for a path
   that's actually still unimplemented.
3. **Docs**: in `AGENTS.md`, find the CmsApi paragraph listing
   S2/S3/S4-scoped operations that 404 (collections is named there) and
   remove "collections" from that list. In `docs/cms-api-data-model.md`,
   append a new `## Collections (S2)` section in the same style as the
   existing `## Tables` / `## What "publish" actually does` / `##
   Availability` / `## Proofs` sections — cover the two new tables, the
   four RPCs' error conditions, and the audit-action strings from Global
   Constraint 12.
4. **End-to-end test**: add one integration-style test (in whichever test
   file/location this repo's convention favors for multi-handler flows —
   check for a precedent, e.g. a products end-to-end test, and mirror its
   location) exercising create → save (bump revision) → publish (with a
   valid product id) → restore an old revision, asserting the response
   shape and revision numbers at each step, using mocked Supabase/RPC calls
   consistent with the other test files in this plan.

Run `npm run lint && npm run typecheck && npm run test` — the full suite,
not just new files, since this task touches the shared router file.

---

## Sequencing after this plan's tasks are all complete

1. Final whole-branch review (this plan's own final review step).
2. PR via `finishing-a-development-branch` — ask before push/PR per that
   skill's own gates.
3. Live acceptance pass against `ceramics-drop-preview` alone (create → save
   → publish with real preview product ids → idempotent replay → restore →
   audit log scoped correctly; negative cases: blank PL description, invalid
   product id, missing Idempotency-Key, stale expectedRevision, unknown
   collection id) — this is a manual/interactive step requiring a deployed
   preview environment, handled after this plan's SDD workspace is closed
   out, not as an SDD task.
4. Only after that pass succeeds: execute
   `cms-ceramics/docs/plans/2026-09-15-collections-v1-cms-wiring.md`.

## Production safety

Entirely additive: two new tables, one relaxed NOT NULL, one new nullable
column + one new CHECK (satisfied by every existing row, since every
existing `catalog_audit_log` row has a non-null `product_id`), four new
RPCs, six new routes — nothing existing dropped, renamed, or given new
required fields. RLS posture matches every sibling table (enabled, no
policies, service-role only). No new public reachability — routes sit behind
the existing CmsApi Service Binding + `verifyCmsAccess` gate, unchanged. No
change to checkout/pricing/order/fulfilment code paths.
