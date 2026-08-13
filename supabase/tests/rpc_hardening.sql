-- pgTAP coverage for the Plan 07 Supabase hardening migration
-- (20260813170000_harden_rpc_and_catalog.sql): M-2 RPC execute revokes, M-3
-- piece_state policy drop, L-10 reservation TTL clamp, M-4 ceramic price
-- guards, L-13 status/stage CHECK constraints. Run with `supabase test db`.
-- Every assertion runs inside the BEGIN/ROLLBACK below, so no fixture data
-- persists. Synthetic `tap_*` ids keep the fixtures clear of real stock.
-- Mirrors private-sale.sql / fulfilment_idempotency.sql structure.

begin;
-- pgTAP lives in `extensions` on Supabase; tables/RPCs in `public`. Missing
-- schemas in search_path are ignored, so this is safe across hosted and local.
set local search_path to extensions, public, pg_temp;

select plan(24);

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

select ok(
  not has_function_privilege('anon', 'publish_print_asset_revision(text,text,jsonb,text)', 'execute'),
  'M-2: anon cannot execute publish_print_asset_revision'
);
select ok(
  not has_function_privilege('authenticated', 'publish_print_asset_revision(text,text,jsonb,text)', 'execute'),
  'M-2: authenticated cannot execute publish_print_asset_revision'
);
select ok(
  has_function_privilege('service_role', 'publish_print_asset_revision(text,text,jsonb,text)', 'execute'),
  'M-2: service_role can execute publish_print_asset_revision'
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
-- NULL-priced ceramic row violates products_ceramic_price_present; a
-- NULL-priced print row is untouched by either ceramic-only CHECK.
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

select lives_ok(
  $$ insert into products (id, type, category_slug, num, price_pln, status)
     values ('tap_price_print_null', 'print', 'fine-art-prints', '99', null, 'draft') $$,
  'M-4: a NULL-priced print row is unaffected by the ceramic-only price CHECKs'
);

-- ── L-13: status / stage CHECK constraints ─────────────────────────────────
insert into orders (id, payment_intent_id, subtotal, shipping, total, shipping_method, status) values
  ('d0000000-0000-0000-0000-000000000001', 'tap_pi_d1', 0, 0, 0, 'odbior', 'pending');

select throws_ok(
  $$ insert into fulfilment_jobs (order_id, idempotency_key, status)
     values ('d0000000-0000-0000-0000-000000000001', 'tap_status_typo', 'canceled') $$,
  '23514',
  null,
  'L-13: a typo''d fulfilment_jobs.status (''canceled'') is rejected (23514 check_violation)'
);

select throws_ok(
  $$ insert into prodigi_orders (order_id, prodigi_status_stage)
     values ('d0000000-0000-0000-0000-000000000001', 'canceled') $$,
  '23514',
  null,
  'L-13: a typo''d prodigi_orders.prodigi_status_stage (''canceled'') is rejected (23514 check_violation)'
);

select lives_ok(
  $$ insert into fulfilment_jobs (order_id, idempotency_key, status)
     values ('d0000000-0000-0000-0000-000000000001', 'tap_status_valid', 'completed') $$,
  'L-13: the newly-permitted ''completed'' fulfilment_jobs.status is accepted'
);

select lives_ok(
  $$ insert into prodigi_orders (order_id, prodigi_status_stage)
     values ('d0000000-0000-0000-0000-000000000001', 'Unknown') $$,
  'L-13: the code fallback ''Unknown'' prodigi_status_stage is accepted'
);

select * from finish();
rollback;
