-- Private sale links: sell specific, already-`sold` pieces to one customer via a
-- secret token, without re-listing them in the public shop. A token maps to an
-- exact set of product ids; checkout reserves those pieces through a dedicated
-- RPC and after payment they simply stay `sold`. See docs/plans/private-sale-cart-link.md.

create table private_sales (
  id          uuid primary key default gen_random_uuid(),
  token       text unique not null,
  product_ids text[] not null,
  expires_at  timestamptz not null,
  consumed_at timestamptz,                 -- set on payment success; single-use link
  created_at  timestamptz not null default now()
);

-- Link an order back to the private sale that authorised it. NULL for normal orders.
-- Release paths (releaseHold / releaseSale / expire / admin release) read this to
-- decide whether freed pieces return to `sold` (private sale) or `available`.
alter table orders add column private_sale_id uuid references private_sales(id);

-- Atomic reservation for a private sale. Unlike reserve_pieces (which rejects
-- `sold`), this allows reserving `sold` pieces, but ONLY for the exact set of ids
-- bound to a valid (unconsumed, unexpired) token. Returns conflicting product_ids
-- (empty array => success). Two sentinels:
--   '{__invalid_token__}'  token missing / consumed / expired
--   p_ids (echoed back)    requested set does not match the sale, or a piece is missing
create or replace function reserve_private_sale_pieces(
  p_token     text,
  p_ids       text[],
  p_order_id  uuid,
  p_ttl_secs  integer
) returns text[]
language plpgsql
as $$
declare
  v_sale_ids text[];
  conflicts  text[];
  v_found    integer;
begin
  -- Lock the active sale row for this token.
  select product_ids into v_sale_ids
  from private_sales
  where token = p_token
    and consumed_at is null
    and expires_at > now()
  for update;

  if v_sale_ids is null then
    return array['__invalid_token__'];
  end if;

  -- Locked bundle: requested ids must equal the sale's set (order/dupes ignored).
  if not (p_ids <@ v_sale_ids and v_sale_ids <@ p_ids) then
    return p_ids;
  end if;

  -- Lock the piece rows.
  perform 1 from piece_state where product_id = any(p_ids) for update;

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

-- Pin search_path (Supabase advisor: function_search_path_mutable), as for reserve_pieces.
alter function public.reserve_private_sale_pieces(text, text[], uuid, integer)
  set search_path = public, pg_temp;

-- RLS: deny anon/auth; only the service role (server-side) touches this table.
alter table private_sales enable row level security;
