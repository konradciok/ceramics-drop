# CMS API data model (S1)

Read this alongside `contracts/cms-v1.json`. It explains the tables/RPCs behind the S1 response shapes so the CMS client code makes sense of `revision`/`publishedRevision`/`status`/`audit` without re-deriving it from ceramics-drop's SQL.

## Tables (new, additive — see `supabase/migrations/20260912120000_cms_api_products.sql`)

- **`product_drafts`** — one immutable row per saved draft. `(product_id, revision)` is unique; `revision` starts at 1 and only ever increments. `payload` is the full `ProductDraft` JSON (title/description/seo/images/variants — everything editable). Nothing is ever deleted or rewritten here: "restore" (a future op) would re-save an old payload as a *new* revision.
- **`products.published_revision`** (new nullable column, composite-FK'd to `product_drafts(product_id, revision)`) — the revision currently live on the storefront, or `null` if never published. `Product.revision` in API responses is `max(product_drafts.revision)` for that product (the latest saved draft, whether or not it's published); `Product.publishedRevision` is this column.
- **`catalog_audit_log.revision`** (new nullable column on the existing table) — every CmsApi write now stamps the revision it acted on, so `GET /v1/audit?resourceId=` can show which revision each entry belongs to. Rows written before this migration have `revision = null`.
- **`cms_api_idempotency_keys`** — leased-CAS ledger for `Idempotency-Key`, one row per `(operation, idempotency_key)`. Shaped like `webhook_events` (see `src/lib/webhook.ts`) but scoped to this API: `status` is `processing → done | failed`; a repeat request with the same key while `status='done'` replays `response_status`/`response_body` verbatim; a repeat with a different `request_hash` is rejected as key reuse.

## What "publish" actually does

`publish_product_revision()` (Postgres RPC) runs as one transaction:
1. Locks the `products` row, checks `expectedRevision` against `max(product_drafts.revision)`.
2. For a **print**: replaces `product_variants` from the draft's `sizes × frameColours × mountAvailable` (minus `unavailable`), each seeded with `print_area_width_px/height_px` from `PRODIGI_SKU_MAP`; then runs the existing `print_asset_readiness_missing()` check. Any variant missing a `ready` proof aborts the whole transaction (nothing changes) and the caller gets `422 PRINT_ASSETS_INCOMPLETE`.
2. For a **ceramic**: writes `price_pln/eur/gbp`, `category_slug`, `measure`, `drop_id`, `seo_title/description` onto the live `products` row; ensures a `default` `product_variants` row and a `piece_state` row exist (insert-if-missing).
3. Replaces `product_media` from the draft's `images`.
4. Sets `products.status = 'active'`, `products.published_revision = expectedRevision`, stamps `published_at` once (first activation only), and writes a `catalog_audit_log` row.

`hide`/`archive` just flip `products.status` (no readiness check, no variant/media replacement).

**Known S1 boundary:** the per-locale `title`/`description`/`seo` text saved in `product_drafts.payload` is *not yet* read by the public storefront for CMS-created products — that read-side wiring is S2 scope. S1's publish action only materializes the fields that already drive `CATALOG_SOURCE=db` rendering (price, category, variants, media, status).

## Availability

`PUT /v1/products/{id}/availability` calls `set_piece_availability_guarded()`, which refuses to touch a piece with an active reservation (`piece_state.status='reserved' AND reserved_until > now()`) and refuses to revert an online-sold piece (`status='sold' AND order_id IS NOT NULL`) — the same rule the existing `/api/admin/set-piece-status` route already enforces.

## Proofs

`POST /v1/products/{id}/proofs/{proofId}` only ever moves an existing `print_fulfilment_assets` row `staged → ready` (approve) or `staged → revoked` (reject) — the same transitions `guard_print_asset_immutable` already allows. It never creates a new asset; uploading new proof images is S3 scope.
