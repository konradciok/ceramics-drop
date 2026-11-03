-- CMS API — print_asset_jobs (Priority 8 / Phase 2: durable job queue).
-- -----------------------------------------------------------------------------
-- Mirrors fulfilment_jobs's CAS-claimed job-row shape (supabase/migrations/
-- 20260626120002_fulfilment_jobs.sql) for the new ASSET_JOBS_QUEUE pipeline
-- that will eventually turn a confirmed print_asset_uploads row (Task 9,
-- Phase 1) into a print_fulfilment_assets row. Phase 2 (this migration + its
-- Worker code) is deliberately a STUB: worker.ts's queue() handler claims the
-- row, marks it 'processing', then a stub terminal state — no real Sharp
-- work, no call into src/server/print-assets/derivatives.ts. Phase 3 (a
-- separate, later task) replaces the stub with the real Container-based
-- processor; this table's shape does not need to change for that.
--
-- Deliberate deviations from fulfilment_jobs, noted rather than silently
-- diverging:
--   - No 'cancelled' status: nothing in this pipeline can be cancelled yet
--     (no admin cancel-job endpoint exists), unlike fulfilment orders.
--   - `idempotency_key` is derived deterministically from `upload_id` alone
--     (see src/server/asset-jobs/enqueue.ts) — there is no "environment"
--     dimension here the way prodigi:{env}:order:{orderId}:v1 has, so (unlike
--     fulfilment_jobs) a SEPARATE partial-unique index on upload_id would be
--     strictly redundant with the idempotency_key uniqueness and is
--     deliberately omitted; a retry re-uses the SAME row (CAS status
--     transition) rather than minting a second one.
--   - `asset_revision` snapshots print_asset_uploads.revision at enqueue time
--     (mirrors the checkout/fulfilment convention of snapshotting referenced
--     state rather than joining it live) — it is what contracts/cms-v1.json's
--     Job.revision reports, and what POST /v1/jobs/{id}/retry's Revision body
--     CAS-guards against (the same `expectedRevision` idiom every other
--     mutating S1-S4 endpoint uses).
create table print_asset_jobs (
  id              uuid primary key default gen_random_uuid(),
  upload_id       uuid not null references print_asset_uploads(id),
  -- Nullable: nothing produces a real print_fulfilment_assets row yet (that is
  -- Phase 3's job) — this stays null for every job this phase ever creates.
  asset_id        uuid references print_fulfilment_assets(id),
  -- Snapshot of print_asset_uploads.revision at enqueue time — see module
  -- comment above. Drives contracts/cms-v1.json's Job.revision.
  asset_revision  integer not null,
  status          text not null default 'queued'
                  check (status in ('queued', 'processing', 'completed', 'failed_retryable', 'failed_action_required')),
  attempts        integer not null default 0,
  idempotency_key text not null unique,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
alter table print_asset_jobs enable row level security;

-- ============================================================
-- Rollback (manual):
--   drop table if exists print_asset_jobs;
-- ============================================================
