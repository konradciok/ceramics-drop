-- Showroom + Drops
-- -----------------------------------------------------------------------------
-- A drop is a limited sales event. After a drop ends, selected pieces can be
-- retired into a "showroom" — still visible, but no longer purchasable — and
-- visitors can register interest in a similar future piece.
--
-- This migration is fully ADDITIVE and backward-compatible: after it ships,
-- with zero admin action, nothing customer-visible changes. Showroom only
-- activates once admin explicitly flags pieces via /admin/inventory.
--
--   1. drops table (+ RLS) and a seed row for the current catalogue.
--   2. piece_state gains showroom / showroom_entered_at / showroom_note.
--   3. product_interest table (+ RLS) for the "request a similar piece" signal.
--   4. reserve_pieces() rejects showroom pieces (authoritative purchase guard),
--      preserving the F4/F7/F8 hardening from 20260706120000.

-- 1. drops ────────────────────────────────────────────────────────────────────
create table drops (
  id         text primary key,        -- slug, e.g. 'drop-1'
  label      text not null,           -- display label, e.g. 'Drop #1'
  status     text not null default 'active' check (status in ('active', 'ended')),
  started_at timestamptz,
  ended_at   timestamptz,
  created_at timestamptz not null default now()
);

-- Same posture as piece_state/orders: deny all to anon/auth; the service role
-- (used server-side) bypasses RLS.
alter table drops enable row level security;

-- Seed the current catalogue as Drop #1 (every existing product defaults to it).
insert into drops (id, label, status, started_at)
values ('drop-1', 'Drop #1', 'active', now());

-- 2. piece_state: showroom columns ────────────────────────────────────────────
-- showroom is independent of status: a row can be (available, showroom=true) or
-- (sold, showroom=true). Defaults backfill every existing row to "not showroom".
alter table piece_state
  add column showroom            boolean not null default false,
  add column showroom_entered_at timestamptz,
  add column showroom_note       text;

-- 3. product_interest ─────────────────────────────────────────────────────────
create table product_interest (
  id                uuid primary key default gen_random_uuid(),
  product_id        text not null,
  email             text not null,
  message           text,
  consent_marketing boolean not null default false,
  locale            text not null,
  created_at        timestamptz not null default now(),
  -- One row per (piece, email): a repeat submission is a no-op upsert, and the
  -- API never leaks whether it was new or a duplicate.
  unique (product_id, email)
);

alter table product_interest enable row level security;

-- 4. reserve_pieces(): reject showroom pieces ─────────────────────────────────
-- Widens the conflict predicate so a showroom piece added via stale client
-- state, a direct API call, or an old bookmarked URL returns through the exact
-- same `409 { error: 'unavailable' }` path checkout already handles. Keeps the
-- F8 (ORDER BY lock), F7 (missing ids → conflicts), and F4 (idempotent retry)
-- fixes from 20260706120000.
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
  perform 1 from piece_state where product_id = any(p_ids) order by product_id for update;

  -- Ids with no row in piece_state can never be fulfilled; fold them into the
  -- conflicts array rather than raising.
  select coalesce(array_agg(id), '{}')
    into missing
  from unnest(p_ids) as id
  where not exists (select 1 from piece_state where product_id = id);

  -- A piece conflicts unless it is free, already reserved by this same order
  -- (idempotent retry), or holds an expired reservation. Showroom pieces are
  -- never purchasable, so they always conflict regardless of status.
  select coalesce(array_agg(product_id), '{}')
    into conflicts
  from piece_state
  where product_id = any(p_ids)
    and (
      showroom = true
      or not (
        status = 'available'
        or (status = 'reserved' and order_id = p_order_id)
        or (status = 'reserved' and reserved_until <= now())
      )
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
