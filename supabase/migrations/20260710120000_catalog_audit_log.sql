-- ============================================================
-- Catalog audit log — who changed what on a product, and when.
-- ------------------------------------------------------------
-- Stage 4a: the admin product editor writes metadata + publish-status changes
-- to the catalog tables. Every mutation records a row here (before/after
-- snapshots + actor), mirroring cms_audit_log for the CMS side.
--
-- product_id is NOT a foreign key: audit rows must survive even if a product id
-- is ever removed from the products table, and products are archived (never hard
-- deleted) anyway. Service-role only (RLS enabled, no policies) — same posture
-- as cms_audit_log and the catalog shadow tables.
-- ============================================================
create table catalog_audit_log (
  id          uuid primary key default gen_random_uuid(),
  product_id  text not null,
  actor_email text,
  action      text not null,           -- 'update' | 'status:draft|active|hidden|archived'
  before      jsonb,
  after       jsonb,
  created_at  timestamptz not null default now()
);

create index catalog_audit_log_product_idx
  on catalog_audit_log(product_id, created_at desc);

alter table catalog_audit_log enable row level security;

-- ============================================================
-- Rollback (manual):
--   drop table if exists catalog_audit_log;
-- ============================================================
