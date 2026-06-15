-- pgTAP tests for the payment-critical reservation RPCs. Run locally with:
--   supabase test db        (wraps each file; pgTAP must be enabled)
-- Every assertion runs inside the BEGIN/ROLLBACK below, so no fixture data
-- persists. Synthetic `tap_*` product ids keep the fixtures clear of real stock.
-- Covers reserve_private_sale_pieces (exact-set match, sold re-sale, idempotent
-- retry, cross-order conflict, invalid/expired/consumed token, double-sale guard)
-- and a regression that the public reserve_pieces still refuses `sold` pieces.

begin;
-- pgTAP lives in `extensions` on Supabase; tables/RPCs in `public`. Missing schemas
-- in search_path are ignored, so this is safe across hosted and local DBs.
set local search_path to extensions, public, pg_temp;

select plan(10);

-- ── Fixtures ────────────────────────────────────────────────────────────────
-- A: happy path / idempotency / cross-order conflict
insert into piece_state (product_id, status) values ('tap_a1', 'sold'), ('tap_a2', 'sold');
insert into private_sales (token, product_ids, expires_at)
  values ('tap_tok_a', array['tap_a1', 'tap_a2'], now() + interval '1 day');

-- B: exact-set mismatch
insert into piece_state (product_id, status) values ('tap_b1', 'sold'), ('tap_b2', 'sold');
insert into private_sales (token, product_ids, expires_at)
  values ('tap_tok_b', array['tap_b1', 'tap_b2'], now() + interval '1 day');

-- D: expired token
insert into piece_state (product_id, status) values ('tap_d1', 'sold');
insert into private_sales (token, product_ids, expires_at)
  values ('tap_tok_d', array['tap_d1'], now() - interval '1 day');

-- E: consumed token
insert into piece_state (product_id, status) values ('tap_e1', 'sold');
insert into private_sales (token, product_ids, expires_at, consumed_at)
  values ('tap_tok_e', array['tap_e1'], now() + interval '1 day', now());

-- F: double-sale guard — a paid order already exists for the sale
insert into piece_state (product_id, status) values ('tap_f1', 'sold');
with s as (
  insert into private_sales (token, product_ids, expires_at)
  values ('tap_tok_f', array['tap_f1'], now() + interval '1 day')
  returning id
)
insert into orders (payment_intent_id, subtotal, shipping, total, shipping_method, status, private_sale_id)
  select 'tap_pi_f', 0, 0, 0, 'odbior', 'paid', id from s;

-- G: public reserve_pieces regression
insert into piece_state (product_id, status) values ('tap_g1', 'sold');

-- ── Tests ─────────────────────────────────────────────────────────────────--
-- A1: exact-set reserve of sold pieces succeeds (no conflicts).
select is(
  reserve_private_sale_pieces('tap_tok_a', array['tap_a1', 'tap_a2'], '11111111-1111-1111-1111-111111111111', 900),
  '{}'::text[],
  'private sale: exact-set reserve of sold pieces returns no conflicts'
);

-- A1b: those pieces are now reserved by that order.
select is(
  (select count(*)::int from piece_state
     where product_id in ('tap_a1', 'tap_a2')
       and status = 'reserved'
       and order_id = '11111111-1111-1111-1111-111111111111'),
  2,
  'private sale: reserved pieces are held by the reserving order'
);

-- A2: a retry by the SAME order is idempotent (no conflicts).
select is(
  reserve_private_sale_pieces('tap_tok_a', array['tap_a1', 'tap_a2'], '11111111-1111-1111-1111-111111111111', 900),
  '{}'::text[],
  'private sale: same-order retry is idempotent'
);

-- A3: a DIFFERENT live order conflicts on the held pieces.
select is(
  (select array(
     select unnest(
       reserve_private_sale_pieces('tap_tok_a', array['tap_a1', 'tap_a2'], '22222222-2222-2222-2222-222222222222', 900)
     ) order by 1)),
  array['tap_a1', 'tap_a2'],
  'private sale: a different order conflicts on pieces held by another order'
);

-- B: a requested set that does not equal the bundle is rejected.
select is(
  reserve_private_sale_pieces('tap_tok_b', array['tap_b1'], '33333333-3333-3333-3333-333333333333', 900),
  array['tap_b1'],
  'private sale: requested set not matching the bundle is rejected'
);

-- C: unknown token → invalid-token sentinel.
select is(
  reserve_private_sale_pieces('does-not-exist', array['tap_a1'], '44444444-4444-4444-4444-444444444444', 900),
  array['__invalid_token__'],
  'private sale: unknown token returns the invalid-token sentinel'
);

-- D: expired token → invalid-token sentinel.
select is(
  reserve_private_sale_pieces('tap_tok_d', array['tap_d1'], '55555555-5555-5555-5555-555555555555', 900),
  array['__invalid_token__'],
  'private sale: expired token returns the invalid-token sentinel'
);

-- E: consumed token → invalid-token sentinel.
select is(
  reserve_private_sale_pieces('tap_tok_e', array['tap_e1'], '66666666-6666-6666-6666-666666666666', 900),
  array['__invalid_token__'],
  'private sale: consumed token returns the invalid-token sentinel'
);

-- F: a paid order for the sale spends the link (double-sale backstop).
select is(
  reserve_private_sale_pieces('tap_tok_f', array['tap_f1'], '77777777-7777-7777-7777-777777777777', 900),
  array['__invalid_token__'],
  'private sale: a paid order for the sale blocks re-reservation'
);

-- G: the public RPC still refuses `sold` pieces — no hole in the shop.
select is(
  reserve_pieces(array['tap_g1'], '88888888-8888-8888-8888-888888888888', 900),
  array['tap_g1'],
  'public reserve_pieces still rejects sold pieces (no shop hole)'
);

select * from finish();
rollback;
