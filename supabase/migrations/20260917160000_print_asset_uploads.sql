-- CMS API — print_asset_uploads (Priority 8 / Phase 1: upload-intent/presign/confirm).
-- -----------------------------------------------------------------------------
-- Tracks the client-driven upload handshake POST /v1/uploads (intent + R2
-- presigned PUT) -> client PUTs bytes directly to R2 -> POST
-- /v1/uploads/{id}/confirm (R2 object metadata check). This is deliberately
-- NOT shaped like 20260917150000_cms_api_shipping_rates.sql's
-- draft/publish/restore RPC set: an upload has no revisions to browse and no
-- "draft" concept — it is one row that moves through exactly one state
-- transition (pending -> confirmed), once. A plpgsql RPC would add ceremony
-- with nothing for it to atomically coordinate that a single CAS `update ...
-- where id = $1 and revision = $2` (the same idempotency.ts leased-CAS style
-- already used elsewhere in this API) does not already give the handler.
--
-- `revision` exists solely so uploads-confirm.ts can require `expectedRevision`
-- per the contract's Revision {expectedRevision} request body, the same generic
-- shape every other mutating S1-S4 endpoint uses. It starts at 0 (nothing has
-- happened yet) and becomes 1 on confirm — there is no third state to advance
-- to in this phase, so unlike shipping_rate_drafts' ever-incrementing counter,
-- this one only ever makes that single 0 -> 1 move.
--
-- Phase 1 explicitly stops at "confirmed" (== "awaiting processing" per the
-- plan's own wording) — Phase 2 is a separate task that adds the job queue
-- deciding what happens to a confirmed upload next. No `status = 'failed'`
-- value exists here: a metadata mismatch at confirm time is reported back to
-- the caller as a 422 and the row is left `pending` (so a client can retry
-- confirm, e.g. after re-uploading, without minting a brand-new intent) —
-- nothing here needs to remember that a check once failed.
--
-- Same RLS posture as every sibling table: enabled, no policies (service-role
-- only, via the CmsApi Worker's service-role key).
create table print_asset_uploads (
  id                     uuid primary key default gen_random_uuid(),

  -- Declared at intent time (POST /v1/uploads body — contract's `Upload`
  -- schema) — what the client SAYS it is about to upload.
  filename               text not null,
  content_type           text not null
                         check (content_type in ('image/jpeg', 'image/png')),
  declared_byte_size     bigint not null check (declared_byte_size > 0),
  ratio                  text not null,

  -- The R2 object key allocated for this upload's presigned PUT target.
  -- Content-addressing (like print_fulfilment_assets.r2_key) is not possible
  -- here: the sha256 is only knowable once the bytes exist, which is after
  -- the client's PUT, not before — so this key is id-addressed instead
  -- (uploads/{id}.{jpg|png}), allocated once at intent time and never reused.
  r2_key                 text not null unique,

  status                 text not null default 'pending'
                         check (status in ('pending', 'confirmed')),
  revision               integer not null default 0,

  -- Observed at confirm time (R2 HEAD on r2_key) — what the object ACTUALLY
  -- is. Null until a successful confirm; compared against the declared_*
  -- columns above by uploads-confirm.ts before being written.
  confirmed_byte_size    bigint,
  confirmed_content_type text,

  created_by             text not null,
  created_at             timestamptz not null default now(),
  -- Presigned PUT URL expiry (echoed as UploadIntent.expiresAt) — informational
  -- only; the R2 S3 API itself is what actually rejects an expired PUT.
  expires_at             timestamptz not null,
  updated_at             timestamptz not null default now()
);

alter table print_asset_uploads enable row level security;

-- ============================================================
-- Rollback (manual):
--   drop table if exists print_asset_uploads;
-- ============================================================
