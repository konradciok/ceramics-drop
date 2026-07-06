-- Harden reserve_pieces / reserve_private_sale_pieces against three checkout-audit
-- findings (F7, F8, and the RPC half of F4):
--
--   F8: the locking `SELECT ... FOR UPDATE` over piece_state had no ORDER BY, so
--       concurrent multi-piece checkouts could lock rows in different orders and
--       deadlock. Both functions now lock by `ORDER BY product_id`.
--   F7: reserve_pieces silently ignored ids with no row in piece_state (a typo'd
--       or already-deleted product_id) instead of surfacing them as unfulfillable.
--       Missing ids are now folded into the conflicts array, same shape as any
--       other unavailable piece, so checkout responds 409 `unavailable` instead
--       of letting the customer pay for a piece that can never ship.
--   F4:  a retried checkout POST (same order_id) used to see its own live hold as
--       a conflict. reserve_pieces now treats `status='reserved' AND order_id =
--       p_order_id` as already-held-by-this-order, mirroring the idempotent-retry
--       clause reserve_private_sale_pieces already has. Expired-hold takeover for
--       other orders is unchanged.

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
  -- conflicts array rather than raising (contrast reserve_private_sale_pieces,
  -- which errors on missing rows).
  select coalesce(array_agg(id), '{}')
    into missing
  from unnest(p_ids) as id
  where not exists (select 1 from piece_state where product_id = id);

  -- A piece conflicts unless it is free, already reserved by this same order
  -- (idempotent retry), or holds an expired reservation.
  select coalesce(array_agg(product_id), '{}')
    into conflicts
  from piece_state
  where product_id = any(p_ids)
    and not (
      status = 'available'
      or (status = 'reserved' and order_id = p_order_id)
      or (status = 'reserved' and reserved_until <= now())
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
