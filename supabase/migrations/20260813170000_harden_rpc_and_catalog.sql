-- Supabase data-API & schema hardening — Remediation Plan 07 (M-2 / M-3 / M-4 /
-- L-10 / L-12 / L-13). Source: docs/superpowers/plans/2026-08-12-remediation-07-supabase-hardening.md
-- -----------------------------------------------------------------------------
-- Six independent hardening blocks, in order:
--   1) M-2  — close default PUBLIC EXECUTE on the four legacy RPCs that never
--             got the revoke house style (reserve_pieces,
--             reserve_private_sale_pieces, publish_cms_version,
--             publish_print_asset_revision). Precedent: link_orders_rpc.sql,
--             harden_guarded_product_status.sql.
--   2) M-3  — drop the out-of-band anon-SELECT policies on piece_state that
--             exist only in the live DB (see RULING below).
--   3) L-10 — clamp p_ttl_secs to [60, 3600] inside reserve_pieces and
--             reserve_private_sale_pieces (CREATE OR REPLACE, full bodies
--             restated verbatim from their latest defining migrations, plus
--             one added clamp line).
--   4) M-4  — CHECK (+ NOT VALID/VALIDATE) that a ceramic row's price_pln is
--             present and > 0; print rows keep nullable price untouched.
--   5) L-12 — three missing FK indexes.
--   6) L-13 — status/stage CHECK constraints on fulfilment_jobs.status and
--             prodigi_orders.prodigi_status_stage.
--
-- Backward-compatibility review (required before merge — this migration
-- auto-applies to prod ~1 min after merge to main, ~6 min BEFORE the new
-- Worker code deploys, so every block below must be safe under the OLD,
-- still-running application code):
--   - The revokes (block 1) only remove anon/authenticated EXECUTE. Every
--     server code path in this repo calls Supabase with the service_role key
--     (adminSupabase() / getSupabaseAdmin() / loadSupabaseClient()) — verified
--     via grep, see AGENTS.md "RLS is enabled; all server-side code uses the
--     service-role key". The still-running old worker is unaffected.
--   - The policy drop (block 2) restores piece_state to deny-all. No server
--     code path ever relied on anon/authenticated reading piece_state directly
--     — /api/inventory reads via the service role (src/lib/inventory.ts) — so
--     this cannot regress the running app either.
--   - The TTL clamp (block 3) only narrows the accepted range for a value that
--     is always 900 at every call site today (checkout, private-sale
--     checkout) — well inside [60, 3600]. All other behaviour (F4/F7/F8
--     hardening, showroom guard) is preserved byte-for-byte.
--   - The price CHECKs (block 4) are validated NOT VALID → VALIDATE against a
--     live read confirming zero NULL/0-priced ceramic rows (125 ceramic rows,
--     47 print rows, all clean) — so VALIDATE cannot fail, and no code path
--     writes a NULL/0 ceramic price today under the NEW admin write schema
--     (`.positive()`, src/lib/catalog/schemas.ts, shipped alongside this
--     migration). The OLD, still-running code during the ~6-minute
--     migration-then-deploy window used `.nonnegative()` (0 allowed): in that
--     narrow window an admin PATCH attempting `price_pln: 0` would get a raw
--     23514 DB error (500) instead of the old code's clean 400 validation
--     rejection. A low-probability edge case — single-operator internal
--     tooling, not a storefront-facing path — worth documenting accurately
--     rather than claiming no code path could hit it.
--   - Only `price_pln` is guarded (block 4), matching Task 1's own SQL
--     template. The plan's "Desired end state" also mentions constraining the
--     ceramic sale/EUR/GBP price columns; this migration deliberately does
--     not, because those columns are inert today — mapCeramicProducts never
--     reads them, and EUR/GBP prices are resolved from per-category constants,
--     not per-product columns. Intentional/correct as shipped; noted here so a
--     future reader doesn't assume full price-column coverage.
--   - The FK indexes (block 5) are pure additions — no behavioural change.
--   - The status CHECKs (block 6) use value lists that are supersets of BOTH
--     (a) every status/stage this repo's code (HEAD) can currently write —
--     see the per-block comments below for the exact enumeration and
--     citations — AND (b) every value actually present in the live prod rows
--     at the time this migration was authored, confirmed by a read-only
--     query run against prod before this migration was written:
--       select distinct status from fulfilment_jobs;
--         -- live result: {cancelled, shipped} — both are in the 8-value list.
--       select distinct prodigi_status_stage from prodigi_orders;
--         -- live result: {InProgress, Complete} — both are in the 5-value list.
--     VALIDATE only needs to hold against what a table's rows already
--     contain, not against what HEAD's code merely CAN write, so the live
--     read (not just the code enumeration) is what actually guarantees
--     VALIDATE cannot fail here. A genuinely new upstream Prodigi stage value
--     remains an accepted, documented risk for prodigi_status_stage going
--     forward (that column mirrors an external API's free-text field).
--
-- Rollback (manual — none of this is auto-reverted by a follow-up migration):
--   -- Block 1 (NOT desired — re-opening PUBLIC execute defeats M-2):
--   --   grant execute on function reserve_pieces(text[], uuid, integer) to public;
--   --   grant execute on function reserve_private_sale_pieces(text, text[], uuid, integer) to public;
--   --   grant execute on function publish_cms_version(uuid, text, integer) to public;
--   --   grant execute on function publish_print_asset_revision(text, text, jsonb, text) to public;
--   -- Block 2 (NOT mechanically revertible — the dropped policies' exact
--   --   definitions were never captured in any migration; recreating them
--   --   requires operator intent + the original USING/WITH CHECK expressions,
--   --   which are unknown — see RULING):
--   --   -- create policy "<name>" on piece_state for select to anon using (...);
--   -- Block 3 (revert the clamp only, restoring the pre-clamp bodies):
--   --   -- CREATE OR REPLACE reserve_pieces/reserve_private_sale_pieces using the
--   --   -- bodies in 20260709130000_showroom_drops.sql / 20260706120000_reserve_pieces_hardening.sql.
--   -- Block 4:
--   --   alter table products drop constraint if exists products_ceramic_price_positive;
--   --   alter table products drop constraint if exists products_ceramic_price_present;
--   -- Block 5:
--   --   drop index if exists product_media_variant_idx;
--   --   drop index if exists products_drop_idx;
--   --   drop index if exists prodigi_orders_order_idx;
--   -- Block 6:
--   --   alter table fulfilment_jobs drop constraint if exists fulfilment_jobs_status_check;
--   --   alter table prodigi_orders drop constraint if exists prodigi_status_stage_check;

-- =============================================================================
-- 1) M-2: close default PUBLIC EXECUTE on the four legacy RPCs.
-- =============================================================================

revoke all on function reserve_pieces(text[], uuid, integer) from public;
revoke execute on function reserve_pieces(text[], uuid, integer) from anon, authenticated;
grant execute on function reserve_pieces(text[], uuid, integer) to service_role;

revoke all on function reserve_private_sale_pieces(text, text[], uuid, integer) from public;
revoke execute on function reserve_private_sale_pieces(text, text[], uuid, integer) from anon, authenticated;
grant execute on function reserve_private_sale_pieces(text, text[], uuid, integer) to service_role;

-- Sole caller: src/lib/admin/content.ts:279 via adminSupabase() (service_role).
revoke all on function publish_cms_version(uuid, text, integer) from public;
revoke execute on function publish_cms_version(uuid, text, integer) from anon, authenticated;
grant execute on function publish_cms_version(uuid, text, integer) to service_role;

-- 4-arg signature only — no 3-arg overload exists live (it was DROP FUNCTION'd
-- in 20260712120000, the same migration that introduced the 4-arg version).
-- Sole caller: scripts/print-assets-publish.ts:92 via loadSupabaseClient()
-- (service_role).
revoke all on function publish_print_asset_revision(text, text, jsonb, text) from public;
revoke execute on function publish_print_asset_revision(text, text, jsonb, text) from anon, authenticated;
grant execute on function publish_print_asset_revision(text, text, jsonb, text) to service_role;

-- =============================================================================
-- 2) M-3: piece_state RLS policy drop — RULING: dynamic drop, not hardcoded
--    names.
-- =============================================================================
--
-- The exact policy names could not be read live in this session (no working
-- SQL-execution tool against prod Postgres — no Supabase CLI token, no direct
-- Postgres connection string, and PostgREST doesn't expose system catalogs).
-- Guessing exact policy name strings is unacceptable: a wrong name under
-- `DROP POLICY IF EXISTS` is a silent no-op that would leave M-3 completely
-- unfixed with no error signal. Use a dynamic DO block instead — it is
-- provably correct regardless of the actual names, matches the acceptance
-- criterion exactly (`select count(*) from pg_policies where
-- tablename='piece_state'` -> 0), and is a safe no-op on shadow/CI DBs where
-- no such policies were ever created. Safe because every server code path
-- uses service_role (bypasses RLS unconditionally — verified via grep,
-- AGENTS.md) and no anon/authenticated client ever reads this table, so
-- removing policies cannot regress the running app.
--
-- Origin note (Task 4): these anon-SELECT policies (a duplicate permissive
-- pair, Supabase advisor 0006) exist only in the live DB — no migration ever
-- created them (grep across all 52 prior migrations: zero `CREATE POLICY`
-- statements outside a prose comment). Out-of-band creation, likely dashboard
-- experimentation; exact origin/timing not independently verifiable without
-- Management API / audit-log access in this session (per plan: "do not spend
-- more than a few minutes"). This migration restores the migrations-are-truth
-- invariant for piece_state.
-- Schema-qualified (c.relnamespace = 'public'::regnamespace and an explicit
-- `on public.piece_state`) so this can never match/drop policies on some
-- other schema's same-named table — not a live risk today (no other
-- piece_state table exists), but this makes the block correct regardless.
do $$
declare
  pol record;
begin
  for pol in
    select p.polname
    from pg_policy p
    join pg_class c on c.oid = p.polrelid
    where c.relname = 'piece_state'
      and c.relnamespace = 'public'::regnamespace
  loop
    execute format('drop policy if exists %I on public.piece_state', pol.polname);
  end loop;
end $$;

-- =============================================================================
-- 3) L-10: clamp p_ttl_secs to [60, 3600] inside both reserve RPCs.
-- =============================================================================
-- Full current bodies restated verbatim (CREATE OR REPLACE preserves the
-- ACL set above — it does not reset grants on an unchanged signature) with a
-- single added line, first statement in each `begin` block. No other
-- behaviour changes: F4 (idempotent retry), F7 (missing ids -> conflicts), F8
-- (ORDER BY lock), and the showroom guard all survive byte-for-byte.

create or replace function reserve_pieces(
  p_ids       text[],
  p_order_id  uuid,
  p_ttl_secs  integer
) returns text[]
language plpgsql
set search_path = public, pg_temp
as $$
declare
  conflicts text[];
  missing   text[];
begin
  -- L-10: bound the caller-supplied TTL so a negative value can't produce an
  -- instantly-expired reservation and a huge value can't produce a
  -- de-facto-permanent hold. Every call site passes 900, well inside range.
  p_ttl_secs := least(greatest(coalesce(p_ttl_secs, 900), 60), 3600);

  perform 1 from piece_state where product_id = any(p_ids) order by product_id for update;

  -- Ids with no row in piece_state can never be fulfilled; fold them into the
  -- conflicts array rather than raising.
  select coalesce(array_agg(id), '{}')
    into missing
  from unnest(p_ids) as id
  where not exists (select 1 from piece_state where product_id = id);

  -- A piece is reservable when it is free (and not showroom), already reserved
  -- by THIS same order (idempotent retry — honoured even if it was toggled into
  -- showroom mid-checkout, so F4 is preserved), or holds an expired reservation
  -- (and not showroom). Showroom blocks NEW purchases and stale-hold takeovers,
  -- but never bricks a buyer's own live hold.
  select coalesce(array_agg(product_id), '{}')
    into conflicts
  from piece_state
  where product_id = any(p_ids)
    and not (
      (status = 'available' and showroom = false)
      or (status = 'reserved' and order_id = p_order_id)
      or (status = 'reserved' and reserved_until <= now() and showroom = false)
    );

  conflicts := conflicts || missing;

  if array_length(conflicts, 1) is not null then
    return conflicts;
  end if;

  update piece_state
     set status = 'reserved',
         reserved_until = now() + make_interval(secs => p_ttl_secs),
         order_id = p_order_id
   where product_id = any(p_ids);

  return '{}';
end;
$$;

create or replace function reserve_private_sale_pieces(
  p_token     text,
  p_ids       text[],
  p_order_id  uuid,
  p_ttl_secs  integer
) returns text[]
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_sale_id  uuid;
  v_sale_ids text[];
  conflicts  text[];
  v_found    integer;
begin
  -- L-10: same clamp as reserve_pieces — see comment there.
  p_ttl_secs := least(greatest(coalesce(p_ttl_secs, 900), 60), 3600);

  -- Lock the active sale row for this token.
  select id, product_ids into v_sale_id, v_sale_ids
  from private_sales
  where token = p_token
    and consumed_at is null
    and expires_at > now()
  for update;

  if v_sale_id is null then
    return array['__invalid_token__'];
  end if;

  -- Defense in depth against a double sale: if the link already produced a paid
  -- order, it is spent — even if `consumed_at` was never written. Treat as invalid.
  if exists (select 1 from orders where private_sale_id = v_sale_id and status = 'paid') then
    return array['__invalid_token__'];
  end if;

  -- Locked bundle: requested ids must equal the sale's set (order/dupes ignored).
  if not (p_ids <@ v_sale_ids and v_sale_ids <@ p_ids) then
    return p_ids;
  end if;

  -- Lock the piece rows.
  perform 1 from piece_state where product_id = any(p_ids) order by product_id for update;

  -- Every requested piece must exist.
  select count(*) into v_found from piece_state where product_id = any(p_ids);
  if v_found <> coalesce(array_length(p_ids, 1), 0) then
    return p_ids;
  end if;

  -- A piece conflicts unless it is sold (v1 re-sale), already reserved by this
  -- same order (idempotent retry), or holds an expired reservation.
  select coalesce(array_agg(product_id), '{}')
    into conflicts
  from piece_state
  where product_id = any(p_ids)
    and not (
      status = 'sold'
      or (status = 'reserved' and order_id = p_order_id)
      or (status = 'reserved' and reserved_until <= now())
    );

  if array_length(conflicts, 1) is not null then
    return conflicts;
  end if;

  update piece_state
     set status = 'reserved',
         reserved_until = now() + make_interval(secs => p_ttl_secs),
         order_id = p_order_id
   where product_id = any(p_ids);

  return '{}';
end;
$$;

-- =============================================================================
-- 4) M-4: price guards. NOT VALID first so existing rows can't block the
--    deploy; VALIDATE immediately after (cheap on this tiny table, but keeps
--    the safe pattern for consistency). A live read in this session confirmed
--    zero NULL/0-priced ceramic rows (125 ceramic rows, 47 print rows total),
--    so both the `> 0` CHECK and the presence (NOT NULL-equivalent) CHECK are
--    safe to ship. Print rows keep nullable price untouched — every clause is
--    guarded by `type <> 'ceramic' or ...`.
-- =============================================================================

alter table products add constraint products_ceramic_price_positive
  check (type <> 'ceramic' or price_pln is null or price_pln > 0) not valid;
alter table products validate constraint products_ceramic_price_positive;

alter table products add constraint products_ceramic_price_present
  check (type <> 'ceramic' or price_pln is not null) not valid;
alter table products validate constraint products_ceramic_price_present;

-- =============================================================================
-- 5) L-12: FK indexes (idempotent).
-- =============================================================================

create index if not exists product_media_variant_idx on product_media(variant_id);
create index if not exists products_drop_idx on products(drop_id);
create index if not exists prodigi_orders_order_idx on prodigi_orders(order_id);

-- =============================================================================
-- 6) L-13: status vocabularies.
-- =============================================================================
--
-- fulfilment_jobs.status — 8 values. `completed` is never currently written
-- but is read/bucketed as terminal/shipped in three places
-- (src/server/fulfilment/enqueue.ts:132, status-map.ts's TERMINAL set,
-- src/lib/account/status.ts's JOB_SHIPPED bucket) — included so a future
-- write of that value doesn't hit the CHECK. `in_production` is deliberately
-- EXCLUDED: status-map.ts's own comment confirms that mapping was dead code,
-- already removed; resurrecting it into a live CHECK would reintroduce
-- removed dead code. Live-row check before authoring this migration —
-- `select distinct status from fulfilment_jobs;` -> {cancelled, shipped} —
-- both already in this list, so VALIDATE below cannot fail.
alter table fulfilment_jobs add constraint fulfilment_jobs_status_check
  check (status in (
    'queued',
    'fulfilment_submitting',
    'fulfilment_submitted',
    'failed_retryable',
    'failed_action_required',
    'cancelled',
    'shipped',
    'completed'
  )) not valid;
alter table fulfilment_jobs validate constraint fulfilment_jobs_status_check;

-- prodigi_orders.prodigi_status_stage — 5 values, nullable. The first four are
-- Prodigi v4's documented top-level stage enum (src/server/prodigi/types.ts:76,
-- live-confirmed by the Plan 11 rehearsal). 'Unknown' is the code's own
-- fallback in merge.ts (`newStage = prodigiOrder.status?.stage ?? 'Unknown'`)
-- — not a Prodigi value, but a real value the code can write, so it must be in
-- the CHECK. This column mirrors an external API's free-text field: a
-- genuinely new upstream Prodigi stage value would make this CHECK reject the
-- write — an accepted, documented risk per the plan's own request for a CHECK
-- here (not a NOT NULL/enum type). Live-row check before authoring this
-- migration — `select distinct prodigi_status_stage from prodigi_orders;`
-- -> {InProgress, Complete} — both already in this list, so VALIDATE below
-- cannot fail.
alter table prodigi_orders add constraint prodigi_status_stage_check
  check (prodigi_status_stage is null or prodigi_status_stage in (
    'Draft',
    'InProgress',
    'Complete',
    'Cancelled',
    'Unknown'
  )) not valid;
alter table prodigi_orders validate constraint prodigi_status_stage_check;
