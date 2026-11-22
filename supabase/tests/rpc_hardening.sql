-- pgTAP coverage for the Plan 07 Supabase hardening migration
-- (20260813170000_harden_rpc_and_catalog.sql): M-2 RPC execute revokes, M-3
-- piece_state policy drop, L-10 reservation TTL clamp and M-4 ceramic price
-- guards (its L-13 checks covered the print fulfilment tables dropped in
-- 20261122120000_drop_print_commerce.sql). Run with `supabase test db`.
-- Every assertion runs inside the BEGIN/ROLLBACK below, so no fixture data
-- persists. Synthetic `tap_*` ids keep the fixtures clear of real stock.
-- Mirrors private-sale.sql / webhook_events_dedup.sql structure.

begin;
-- pgTAP lives in `extensions` on Supabase; tables/RPCs in `public`. Missing
-- schemas in search_path are ignored, so this is safe across hosted and local.
set local search_path to extensions, public, pg_temp;

select plan(16);

-- ── M-2: RPC execute privileges ────────────────────────────────────────────
-- anon/authenticated must NOT be able to execute any of the four legacy RPCs;
-- service_role must still be able to (the only intended caller in every case).

select ok(
  not has_function_privilege('anon', 'reserve_pieces(text[],uuid,integer)', 'execute'),
  'M-2: anon cannot execute reserve_pieces'
);
select ok(
  not has_function_privilege('authenticated', 'reserve_pieces(text[],uuid,integer)', 'execute'),
  'M-2: authenticated cannot execute reserve_pieces'
);
select ok(
  has_function_privilege('service_role', 'reserve_pieces(text[],uuid,integer)', 'execute'),
  'M-2: service_role can execute reserve_pieces'
);

select ok(
  not has_function_privilege('anon', 'reserve_private_sale_pieces(text,text[],uuid,integer)', 'execute'),
  'M-2: anon cannot execute reserve_private_sale_pieces'
);
select ok(
  not has_function_privilege('authenticated', 'reserve_private_sale_pieces(text,text[],uuid,integer)', 'execute'),
  'M-2: authenticated cannot execute reserve_private_sale_pieces'
);
select ok(
  has_function_privilege('service_role', 'reserve_private_sale_pieces(text,text[],uuid,integer)', 'execute'),
  'M-2: service_role can execute reserve_private_sale_pieces'
);

select ok(
  not has_function_privilege('anon', 'publish_cms_version(uuid,text,integer)', 'execute'),
  'M-2: anon cannot execute publish_cms_version'
);
select ok(
  not has_function_privilege('authenticated', 'publish_cms_version(uuid,text,integer)', 'execute'),
  'M-2: authenticated cannot execute publish_cms_version'
);
select ok(
  has_function_privilege('service_role', 'publish_cms_version(uuid,text,integer)', 'execute'),
  'M-2: service_role can execute publish_cms_version'
);

-- ── M-3: piece_state has zero policies ─────────────────────────────────────
select is(
  (select count(*)::int from pg_policies where tablename = 'piece_state'),
  0,
  'M-3: piece_state has zero RLS policies (out-of-band anon-SELECT pair dropped)'
);

-- ── L-10: reservation TTL clamp ────────────────────────────────────────────
-- reserve_pieces: a negative TTL clamps up to the 60s floor; a huge TTL
-- clamps down to the 3600s ceiling. Both cases still succeed (no conflicts)
-- since the pieces are available.
insert into piece_state (product_id, status) values
  ('tap_ttl_neg', 'available'),
  ('tap_ttl_huge', 'available');
-- Reuse the seeded 'drop-1' (20260709130000_showroom_drops.sql) rather than
-- inserting a second active drop — drops_single_active
-- (20260914120000_ceramic_drop_default_and_copy.sql) allows at most one.
insert into products(id,type,category_slug,num,price_pln,status,drop_id) values
  ('tap_ttl_neg','ceramic','kubki','01',100,'active','drop-1'),
  ('tap_ttl_huge','ceramic','kubki','02',100,'active','drop-1');

select is(
  reserve_pieces(array['tap_ttl_neg'], 'a0000000-0000-0000-0000-000000000001', -5),
  '{}'::text[],
  'L-10: reserve_pieces with a negative TTL still succeeds (clamped, not rejected)'
);

select ok(
  (select reserved_until from piece_state where product_id = 'tap_ttl_neg')
    between now() + interval '55 seconds' and now() + interval '65 seconds',
  'L-10: reserve_pieces clamps a negative TTL up to the 60s floor'
);

select is(
  reserve_pieces(array['tap_ttl_huge'], 'a0000000-0000-0000-0000-000000000002', 999999),
  '{}'::text[],
  'L-10: reserve_pieces with a huge TTL still succeeds (clamped, not unbounded)'
);

select ok(
  (select reserved_until from piece_state where product_id = 'tap_ttl_huge')
    between now() + interval '3595 seconds' and now() + interval '3605 seconds',
  'L-10: reserve_pieces clamps a huge TTL down to the 3600s ceiling'
);

-- ── M-4: ceramic price guards ───────────────────────────────────────────────
-- A 0-priced ceramic row violates products_ceramic_price_positive; a
-- NULL-priced ceramic row violates products_ceramic_price_present.
select throws_ok(
  $$ insert into products (id, type, category_slug, num, price_pln, status)
     values ('tap_price_zero', 'ceramic', 'kubki', '99', 0, 'draft') $$,
  '23514',
  null, -- skip matching the (locale-dependent) message text; errcode is enough
  'M-4: a 0-priced ceramic insert is rejected (23514 check_violation)'
);

select throws_ok(
  $$ insert into products (id, type, category_slug, num, price_pln, status)
     values ('tap_price_null', 'ceramic', 'kubki', '99', null, 'draft') $$,
  '23514',
  null, -- skip matching the (locale-dependent) message text; errcode is enough
  'M-4: a NULL-priced ceramic insert is rejected (23514 check_violation, products_ceramic_price_present)'
);


select * from finish();
rollback;
