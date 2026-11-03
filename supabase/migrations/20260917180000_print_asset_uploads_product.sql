-- CMS API — print_asset_uploads.product_id (Priority 8 / Phase 3: Container processor).
-- -----------------------------------------------------------------------------
-- WHY THIS EXISTS (a gap found while implementing Phase 3, not planned schema):
--
-- Phase 3's success path must "insert print_fulfilment_assets rows at
-- status='staged'". `print_fulfilment_assets.product_id` is `text NOT NULL
-- references products(id)` (20260711120000_print_fulfilment_assets.sql) — but
-- NOTHING in the Phase 1/2 upload+job pipeline carries a product association:
--   - print_asset_uploads (20260917160000) has filename/content_type/bytes/
--     ratio/r2_key/created_by and no product column;
--   - print_asset_jobs (20260917170000) references only upload_id;
--   - contracts/cms-v1.json's `Upload` schema (additionalProperties: false)
--     has no productId field either.
-- So a derivative produced by the Container is, today, un-attributable to a
-- product and cannot become a print_fulfilment_assets row at all.
--
-- This migration adds the minimum missing link: a NULLABLE product reference
-- on the upload row. Nullable (not NOT NULL) deliberately:
--   - Phase 1's POST /v1/uploads does not accept a productId yet and the
--     contract change to add one is out of this task's scope (it is shared
--     with the CMS repo, which pins its own copy of the contract), so every
--     row that exists today has no product;
--   - a NOT NULL column would break every existing/in-flight upload row.
--
-- Until POST /v1/uploads is extended to accept and persist `product_id`, the
-- queue consumer (src/server/asset-jobs/process-job.ts) fails a job whose
-- upload has no product_id as `failed_action_required` with an explicit
-- message, rather than silently "completing" a job that produced nothing.
-- That is the honest terminal state for a structurally-incomplete input.
--
-- ON DELETE: `restrict` rather than the print_fulfilment_assets convention of
-- `cascade` — an upload row is an audit record of an operator action, and a
-- product delete should not silently erase the evidence that bytes were
-- uploaded for it. Products are archived, not deleted, in this catalogue.
alter table print_asset_uploads
  add column product_id text references products(id) on delete restrict;

create index print_asset_uploads_product_idx
  on print_asset_uploads (product_id)
  where product_id is not null;

-- ============================================================
-- Rollback (manual):
--   drop index if exists print_asset_uploads_product_idx;
--   alter table print_asset_uploads drop column if exists product_id;
-- ============================================================
