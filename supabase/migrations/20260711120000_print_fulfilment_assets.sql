-- Print fulfilment assets + atomic revision-publish RPC — Phase 1a of the
-- print-asset-pipeline remediation (docs/plans/print-asset-pipeline.md §2–§3).
-- -----------------------------------------------------------------------------
-- This migration is the keystone of the pipeline: it makes a print's fulfilment
-- asset immutable + content-addressed, and introduces the readiness gate
-- (`publish_print_asset_revision`) that every publish and checkout will check.
--
-- Nothing in the storefront reads these tables yet (TS helpers + readiness are
-- Task 1d; the seed/backfill of print-area pixels is Task 1b). The migration is
-- additive: two new tables, two nullable columns on product_variants, an
-- immutability trigger, and one RPC.
--
-- Same RLS posture as the catalog shadow tables / piece_state / orders: deny
-- all to anon/authenticated; only the service-role key (used server-side)
-- bypasses RLS. RPCs are hardened with `set search_path = public, pg_temp`
-- (Supabase advisor `function_search_path_mutable`), matching publish_cms_version
-- and reserve_pieces — NOT `security definer`, which no RPC in this repo uses.

-- 1. print_fulfilment_assets ──────────────────────────────────────────────────
-- One row per uploaded R2 object. The `r2_key` is content-addressed
-- (prints/{productId}/{revision}/{w}x{h}-{sha256}.{jpg|png}) and never reused.
-- Once promoted past `staged`, content columns are frozen by the trigger below;
-- only allowed status transitions and verified_at may change thereafter.
create table print_fulfilment_assets (
  id            uuid primary key default gen_random_uuid(),
  product_id    text not null references products(id) on delete cascade,
  revision      text not null,
  profile_key   text,                          -- distinct dimension set, e.g. '3600x4800'
  r2_key        text not null unique,          -- prints/{id}/{rev}/{w}x{h}-{sha256}.{jpg|png}
  sha256        text not null,
  content_type  text not null
                check (content_type in ('image/jpeg', 'image/png')),
  width_px      integer not null check (width_px > 0),
  height_px     integer not null check (height_px > 0),
  byte_size     bigint not null check (byte_size > 0),
  status        text not null default 'staged'
                check (status in ('staged', 'ready', 'retired', 'revoked')),
  created_at    timestamptz not null default now(),
  verified_at   timestamptz
);

alter table print_fulfilment_assets enable row level security;

create index print_fulfilment_assets_product_idx
  on print_fulfilment_assets (product_id);
create index print_fulfilment_assets_product_status_idx
  on print_fulfilment_assets (product_id, status);
create index print_fulfilment_assets_product_revision_idx
  on print_fulfilment_assets (product_id, revision);

-- 2. print_variant_asset_assignments ──────────────────────────────────────────
-- The currently-live asset per (product, variant). The publish RPC swaps every
-- row for a product in one transaction, so a revision goes live atomically.
-- NOT FK'd to product_variants.id (that row is replaceable); the natural key
-- (product_id, variant_key) is validated against active catalogue variants
-- inside the publish RPC.
create table print_variant_asset_assignments (
  product_id   text not null references products(id) on delete cascade,
  variant_key  text not null,
  asset_id     uuid not null references print_fulfilment_assets(id) on delete restrict,
  created_at   timestamptz not null default now(),
  primary key (product_id, variant_key)
);

alter table print_variant_asset_assignments enable row level security;

create index print_variant_asset_assignments_asset_idx
  on print_variant_asset_assignments (asset_id);

-- 3. Per-variant print-area pixels ─────────────────────────────────────────────
-- The database-side contract the publish RPC checks: a `ready` asset's
-- width/height must equal the variant's print area (seeded from
-- PRODIGI_SKU_MAP[variant_key].printAreaPx in Task 1b). null for ceramics.
alter table product_variants
  add column print_area_width_px  integer,
  add column print_area_height_px integer,
  add constraint product_variants_print_area_paired check (
    (print_area_width_px is null and print_area_height_px is null)
    or (print_area_width_px is not null and print_area_height_px is not null
        and print_area_width_px > 0 and print_area_height_px > 0)
  );

-- 4. Update guard (immutability + status transitions) ───────────────────────────
-- Content columns (revision, profile_key, r2_key, hash, type, byte size,
-- dimensions, owning product) freeze once an asset leaves `staged`. Historical
-- orders may reference `retired` assets via the signed route (Phase 4), so
-- immutability extends through retired and revoked — not only `ready`.
--
-- Allowed status transitions:
--   staged  → ready | revoked
--   ready   → retired | revoked
--   retired → revoked
--   revoked → (none)
create or replace function guard_print_asset_immutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status is distinct from old.status then
    if old.status = 'staged' and new.status not in ('ready', 'revoked') then
      raise 'invalid_status_transition';
    elsif old.status = 'ready' and new.status not in ('retired', 'revoked') then
      raise 'invalid_status_transition';
    elsif old.status = 'retired' and new.status <> 'revoked' then
      raise 'invalid_status_transition';
    elsif old.status = 'revoked' then
      raise 'invalid_status_transition';
    end if;
  end if;

  if old.status in ('ready', 'retired', 'revoked') then
    if new.revision     is distinct from old.revision
    or new.profile_key  is distinct from old.profile_key
    or new.r2_key       is distinct from old.r2_key
    or new.sha256       is distinct from old.sha256
    or new.content_type is distinct from old.content_type
    or new.width_px     is distinct from old.width_px
    or new.height_px    is distinct from old.height_px
    or new.byte_size    is distinct from old.byte_size
    or new.product_id   is distinct from old.product_id then
      raise 'asset_immutable';
    end if;
  end if;

  return new;
end;
$$;

create trigger print_fulfilment_assets_guard_immutable
  before update on print_fulfilment_assets
  for each row execute function guard_print_asset_immutable();

-- 5. Atomic revision publish ──────────────────────────────────────────────────
-- Atomically assigns a revision's assets to every active variant of a print
-- product. The readiness gate: validates exact variant coverage, every asset is
-- ready + owned by the product + dimensionally correct, then swaps assignments
-- in one statement so a new revision goes live and any failure leaves the prior
-- assignment set intact. Mirrors publish_cms_version (single transaction under a
-- product-level FOR UPDATE lock; search_path pinned; column refs table-aliased).
create or replace function publish_print_asset_revision(
  p_product_id   text,
  p_revision     text,
  p_assignments  jsonb
) returns table (
  product_id     text,
  revision       text,
  assigned_count integer
)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_active_keys   text[];
  v_assign_keys   text[];
  v_missing       text[];
  v_extra         text[];
  v_total         integer;
  v_distinct      integer;
  v_fail_key      text;
  v_fail_reason   text;
  v_before        jsonb;
  v_count         integer;
begin
  -- Qualify EVERY column reference with a table alias: RETURNS TABLE columns
  -- (product_id, revision, assigned_count) are OUT-parameter names in scope, so
  -- a bare `product_id` / `revision` is ambiguous (SQLSTATE 42702). Same hazard
  -- publish_cms_version calls out.

  -- (1) Lock the print product. FOR UPDATE serialises concurrent publishes.
  perform 1 from products p
    where p.id = p_product_id
      and p.type = 'print'
    for update;
  if not found then
    raise 'product_not_found';
  end if;

  -- (2) Exact coverage: the active-variant key set must equal the assignment key
  -- set — no missing, no extra, no duplicate.
  select array_agg(pv.variant_key order by pv.variant_key)
    into v_active_keys
    from product_variants pv
   where pv.product_id = p_product_id
     and pv.active;

  select array_agg(a.k), count(*), count(distinct a.k)
    into v_assign_keys, v_total, v_distinct
    from (select j->>'variant_key' as k from jsonb_array_elements(p_assignments) j) a;

  select array_agg(k)
    into v_missing
    from unnest(coalesce(v_active_keys, array[]::text[])) as k
   where k <> all (coalesce(v_assign_keys, array[]::text[]));

  select array_agg(k)
    into v_extra
    from unnest(coalesce(v_assign_keys, array[]::text[])) as k
   where k <> all (coalesce(v_active_keys, array[]::text[]));

  if coalesce(array_length(v_missing, 1), 0) > 0
      or coalesce(array_length(v_extra, 1), 0) > 0
      or coalesce(v_total, 0) <> coalesce(v_distinct, 0) then
    raise 'assignment_mismatch' using
      detail = format(
        'missing=%L extra=%L duplicate=%L',
        v_missing,
        v_extra,
        case when coalesce(v_total, 0) <> coalesce(v_distinct, 0) then true else false end
      );
  end if;

  -- (2b) Reject malformed asset_id values before casting to uuid.
  if exists (
    select 1
      from jsonb_array_elements(p_assignments) j(elem)
     where not ((j.elem->>'asset_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  ) then
    raise 'invalid_asset_id';
  end if;

  -- (3) Per-assignment readiness: asset exists, belongs to this product, is
  -- `ready`, matches p_revision, and its dimensions equal the variant's print
  -- area. A null print_area_*_px (variant not yet seeded) compares unequal →
  -- dimension mismatch, i.e. fail-closed. Raise the first classified failure.
  select a.var_key, a.reason
    into v_fail_key, v_fail_reason
    from (
      select pv.variant_key as var_key,
             case
               when pfa.id is null or pfa.product_id is distinct from p_product_id
                 then 'wrong_product'
               when pfa.status <> 'ready'
                 then 'asset_not_ready'
               when pfa.revision is distinct from p_revision
                 then 'revision_mismatch'
               when pfa.width_px  is distinct from pv.print_area_width_px
                 or pfa.height_px is distinct from pv.print_area_height_px
                 then 'dimension_mismatch'
             end as reason,
             j.idx as idx
        from jsonb_array_elements(p_assignments) with ordinality as j(obj, idx)
        join product_variants pv
          on pv.product_id = p_product_id
         and pv.variant_key = j.obj->>'variant_key'
        left join print_fulfilment_assets pfa
          on pfa.id = (j.obj->>'asset_id')::uuid
       where pfa.id is null
          or pfa.product_id is distinct from p_product_id
          or pfa.status <> 'ready'
          or pfa.revision is distinct from p_revision
          or pfa.width_px  is distinct from pv.print_area_width_px
          or pfa.height_px is distinct from pv.print_area_height_px
    ) a
    order by a.idx
    limit 1;

  if v_fail_reason is not null then
    raise '%', v_fail_reason using detail = format('variant_key=%L', v_fail_key);
  end if;

  -- Snapshot the pre-publish assignment set for the audit record (before the
  -- swap empties it).
  select coalesce(
           jsonb_agg(jsonb_build_object('variant_key', aa.variant_key, 'asset_id', aa.asset_id)
                     order by aa.variant_key),
           '[]'::jsonb)
    into v_before
    from print_variant_asset_assignments aa
   where aa.product_id = p_product_id;

  -- (4) Atomic swap: delete every existing assignment for the product, then
  -- insert the new set. Both statements share this transaction, so any failure
  -- (or a raised check above) rolls the prior assignments back intact.
  delete from print_variant_asset_assignments pa
   where pa.product_id = p_product_id;

  insert into print_variant_asset_assignments (product_id, variant_key, asset_id)
  select p_product_id, j.obj->>'variant_key', (j.obj->>'asset_id')::uuid
    from jsonb_array_elements(p_assignments) with ordinality as j(obj, idx);

  select count(*) into v_count
    from print_variant_asset_assignments pa
   where pa.product_id = p_product_id;

  -- (5) Audit record. catalog_audit_log already encodes (product_id, action,
  -- before, after) — exactly this event's shape — so we reuse it rather than
  -- add a parallel mechanism. actor_email comes from the optional app.actor_email
  -- GUC the calling script may set; null otherwise.
  insert into catalog_audit_log (product_id, actor_email, action, before, after)
  values (
    p_product_id,
    nullif(current_setting('app.actor_email', true), ''),
    'print_asset_publish',
    v_before,
    jsonb_build_object('revision', p_revision, 'assignments', p_assignments)
  );

  return query
  select p_product_id, p_revision, v_count;
end;
$$;

-- ============================================================
-- Rollback (manual):
--   drop function if exists publish_print_asset_revision(text, text, jsonb);
--   drop function if exists guard_print_asset_immutable();
--   drop table if exists print_variant_asset_assignments;
--   drop table if exists print_fulfilment_assets;
--   alter table product_variants
--     drop column if exists print_area_height_px,
--     drop column if exists print_area_width_px;
-- ============================================================
