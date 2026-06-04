-- One-of-a-kind inventory + orders ledger for Stripe payments.

create type piece_status as enum ('available', 'reserved', 'sold');
create type order_status as enum ('pending', 'paid', 'failed', 'expired');

create table piece_state (
  product_id     text primary key,
  status         piece_status not null default 'available',
  reserved_until timestamptz,
  order_id       uuid
);

create table orders (
  id                uuid primary key default gen_random_uuid(),
  payment_intent_id text unique not null,
  status            order_status not null default 'pending',
  currency          text not null default 'pln',
  subtotal          integer not null,         -- grosze
  shipping          integer not null,         -- grosze
  total             integer not null,         -- grosze
  shipping_method   text not null,            -- 'kurier' | 'odbior'
  email             text,
  shipping_address  jsonb,
  created_at        timestamptz not null default now(),
  paid_at           timestamptz
);

create table order_items (
  order_id   uuid not null references orders(id) on delete cascade,
  product_id text not null,
  unit_price integer not null,                -- grosze
  primary key (order_id, product_id)
);

-- Atomic reservation: locks the requested rows, rejects if any is sold or
-- actively reserved, else marks them reserved until now()+ttl.
-- Returns the conflicting product_ids (empty array => success).
create or replace function reserve_pieces(
  p_ids       text[],
  p_order_id  uuid,
  p_ttl_secs  integer
) returns text[]
language plpgsql
as $$
declare
  conflicts text[];
begin
  perform 1 from piece_state where product_id = any(p_ids) for update;

  select coalesce(array_agg(product_id), '{}')
    into conflicts
  from piece_state
  where product_id = any(p_ids)
    and (status = 'sold'
         or (status = 'reserved' and reserved_until > now()));

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

-- Seed all 88 pieces as available.
insert into piece_state (product_id, status)
select 'k' || lpad(g::text, 2, '0'), 'available'::piece_status from generate_series(1,22) g
union all select 'v' || lpad(g::text,2,'0'),'available'::piece_status from generate_series(1,8) g
union all select 'd' || lpad(g::text,2,'0'),'available'::piece_status from generate_series(1,9) g
union all select 't' || lpad(g::text,2,'0'),'available'::piece_status from generate_series(1,15) g
union all select 'p' || lpad(g::text,2,'0'),'available'::piece_status from generate_series(1,12) g
union all select 'b' || lpad(g::text,2,'0'),'available'::piece_status from generate_series(1,6) g
union all select 'w' || lpad(g::text,2,'0'),'available'::piece_status from generate_series(1,16) g
on conflict (product_id) do nothing;

update piece_state set status = 'sold'
 where product_id in ('k04','k11','k19','v02','v06');

-- RLS: deny everything to anon/auth; only the service role (used server-side) bypasses RLS.
alter table piece_state enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
