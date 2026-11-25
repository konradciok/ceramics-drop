-- pgTAP tests for 20261125120000_release_orphaned_checkout_hold.sql: the
-- checkout's guarded hold release frees an order's reserved pieces only when no
-- live (pending / paid) order owns them. Run locally with:
--   supabase test db
-- Every assertion runs inside the BEGIN/ROLLBACK below, so no fixture data
-- persists. Synthetic `tap_rh_*` ids keep fixtures clear of real stock.

begin;
set local search_path to extensions, public, pg_temp;

select plan(17);

-- ── Privileges ─────────────────────────────────────────────────────────────
select ok(
  not has_function_privilege('anon', 'release_orphaned_checkout_hold(uuid,text)', 'execute'),
  'anon cannot execute release_orphaned_checkout_hold'
);
select ok(
  not has_function_privilege('authenticated', 'release_orphaned_checkout_hold(uuid,text)', 'execute'),
  'authenticated cannot execute release_orphaned_checkout_hold'
);
select ok(
  has_function_privilege('service_role', 'release_orphaned_checkout_hold(uuid,text)', 'execute'),
  'service_role can execute release_orphaned_checkout_hold'
);

-- ── Fixtures ────────────────────────────────────────────────────────────────
-- Order ids: a1 no orders row (the attempt died before its insert), b1 pending,
-- c1 paid, d1 failed, e1 no orders row (private-sale hold), f1 another order.
insert into piece_state (product_id, status, reserved_until, order_id) values
  ('tap_rh_a1', 'reserved', now() + interval '15 minutes', 'aaaaaaaa-0000-0000-0000-000000000001'),
  ('tap_rh_a2', 'reserved', now() + interval '15 minutes', 'aaaaaaaa-0000-0000-0000-000000000001'),
  ('tap_rh_b1', 'reserved', now() + interval '15 minutes', 'bbbbbbbb-0000-0000-0000-000000000001'),
  ('tap_rh_c1', 'reserved', now() + interval '15 minutes', 'cccccccc-0000-0000-0000-000000000001'),
  ('tap_rh_d1', 'reserved', now() + interval '15 minutes', 'dddddddd-0000-0000-0000-000000000001'),
  ('tap_rh_e1', 'reserved', now() + interval '15 minutes', 'eeeeeeee-0000-0000-0000-000000000001'),
  ('tap_rh_f1', 'reserved', now() + interval '15 minutes', 'ffffffff-0000-0000-0000-000000000001');
-- A piece already sold to order a1 must never be touched by its release.
insert into piece_state (product_id, status, order_id) values
  ('tap_rh_a3', 'sold', 'aaaaaaaa-0000-0000-0000-000000000001');

insert into orders (id, payment_intent_id, subtotal, shipping, total, shipping_method, status) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'tap_rh_pi_b', 0, 0, 0, 'odbior', 'pending'),
  ('cccccccc-0000-0000-0000-000000000001', 'tap_rh_pi_c', 0, 0, 0, 'odbior', 'paid'),
  ('dddddddd-0000-0000-0000-000000000001', 'tap_rh_pi_d', 0, 0, 0, 'odbior', 'failed');

-- ── No orders row: the hold is orphaned and is freed ───────────────────────
select is(
  release_orphaned_checkout_hold('aaaaaaaa-0000-0000-0000-000000000001', 'available'),
  'released',
  'no orders row: released'
);
select is(
  (select count(*)::int from piece_state
    where product_id in ('tap_rh_a1', 'tap_rh_a2')
      and status = 'available' and order_id is null and reserved_until is null),
  2,
  'no orders row: every reserved piece is available again'
);
select is(
  (select status::text from piece_state where product_id = 'tap_rh_a3'),
  'sold',
  'no orders row: a sold piece of the same order is untouched'
);
select is(
  (select order_id from piece_state where product_id = 'tap_rh_f1'),
  'ffffffff-0000-0000-0000-000000000001'::uuid,
  'another order''s hold is untouched'
);
select is(
  release_orphaned_checkout_hold('aaaaaaaa-0000-0000-0000-000000000001', 'available'),
  'released',
  'a second release is a no-op that still answers released'
);

-- ── A live order owns the hold: nothing is freed ───────────────────────────
select is(
  release_orphaned_checkout_hold('bbbbbbbb-0000-0000-0000-000000000001', 'available'),
  'live_order',
  'pending order: live_order'
);
select is(
  (select status::text from piece_state where product_id = 'tap_rh_b1'),
  'reserved',
  'pending order: the piece stays reserved'
);
select is(
  release_orphaned_checkout_hold('cccccccc-0000-0000-0000-000000000001', 'available'),
  'live_order',
  'paid order: live_order (markPaid sets the order paid before the pieces sold)'
);
select is(
  (select status::text from piece_state where product_id = 'tap_rh_c1'),
  'reserved',
  'paid order: the piece stays reserved for markPaid to sell'
);

-- ── A dead order no longer owns the hold ───────────────────────────────────
select is(
  release_orphaned_checkout_hold('dddddddd-0000-0000-0000-000000000001', 'available'),
  'released',
  'failed order: released'
);
select is(
  (select status::text from piece_state where product_id = 'tap_rh_d1'),
  'available',
  'failed order: the piece is available again'
);

-- ── Private-sale target ────────────────────────────────────────────────────
select is(
  release_orphaned_checkout_hold('eeeeeeee-0000-0000-0000-000000000001', 'sold'),
  'released',
  'private-sale hold: released'
);
select is(
  (select status::text from piece_state where product_id = 'tap_rh_e1'),
  'sold',
  'private-sale hold: the piece returns to sold, never available'
);

-- ── Input guard ────────────────────────────────────────────────────────────
select throws_ok(
  $$ select release_orphaned_checkout_hold('aaaaaaaa-0000-0000-0000-000000000001', 'reserved') $$,
  'P0001', 'invalid_release_target',
  'a target other than available / sold is refused'
);

select * from finish();
rollback;
