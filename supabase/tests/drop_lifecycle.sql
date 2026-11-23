-- pgTAP coverage for 20261122130000_drop_lifecycle.sql: the `upcoming` drop
-- status, the single-upcoming index, and launch_drop() switching the active
-- drop atomically — including its effect on ceramic_drop_conflicts (the
-- purchase guard). Run with `supabase test db`. Every assertion runs inside
-- the BEGIN/ROLLBACK below; synthetic `tap_*` ids keep fixtures clear of real
-- stock. Relies on the seeded `drop-1` being the active drop.

begin;
set local search_path to extensions, public, pg_temp;

-- A migration may already seed the next real drop as upcoming (drop-2 in
-- 20261123120000_drop2_seed.sql). At most one drop can be upcoming, so park any
-- such drop as ended for this transaction; the ROLLBACK below restores it.
update drops set status = 'ended' where status = 'upcoming';

select plan(14);

select lives_ok(
  $$ insert into drops (id, label, status) values ('tap_drop_next', 'Drop TAP', 'upcoming') $$,
  'drop lifecycle: an upcoming drop can be created while another drop is active'
);

select throws_ok(
  $$ insert into drops (id, label, status) values ('tap_drop_extra', 'Drop TAP 2', 'upcoming') $$,
  '23505',
  null,
  'drop lifecycle: a second upcoming drop is rejected (drops_single_upcoming)'
);

insert into products (id, type, category_slug, num, price_pln, status, drop_id) values
  ('tap_old', 'ceramic', 'kubki', '98', 100, 'active', 'drop-1'),
  ('tap_new', 'ceramic', 'kubki', '99', 100, 'active', 'tap_drop_next');
insert into piece_state (product_id, status, showroom) values
  ('tap_old', 'available', false),
  ('tap_new', 'available', false);

select is(
  ceramic_drop_conflicts(array['tap_old', 'tap_new'], gen_random_uuid()),
  array['tap_new'],
  'drop lifecycle: before launch only the upcoming piece is unpurchasable'
);

select throws_ok(
  $$ select launch_drop('tap_drop_missing') $$,
  'drop_not_found',
  'drop lifecycle: launching an unknown drop is rejected'
);

select throws_ok(
  $$ select launch_drop('drop-1') $$,
  'drop_not_upcoming',
  'drop lifecycle: launching a drop that is not upcoming is rejected'
);

select is(
  launch_drop('tap_drop_next'),
  '{"ended": "drop-1", "started": "tap_drop_next"}'::jsonb,
  'drop lifecycle: launch_drop reports the ended and the started drop'
);

select is(
  (select status from drops where id = 'drop-1'),
  'ended',
  'drop lifecycle: the previously active drop is ended'
);

select ok(
  (select ended_at is not null from drops where id = 'drop-1'),
  'drop lifecycle: the ended drop is stamped with ended_at'
);

select is(
  (select status from drops where id = 'tap_drop_next'),
  'active',
  'drop lifecycle: the upcoming drop is now active'
);

select is(
  (select count(*)::int from drops where status = 'active'),
  1,
  'drop lifecycle: exactly one drop is active after the switch'
);

select is(
  ceramic_drop_conflicts(array['tap_old', 'tap_new'], gen_random_uuid()),
  array['tap_old'],
  'drop lifecycle: after launch only the old piece is unpurchasable'
);

select ok(
  not has_function_privilege('anon', 'launch_drop(text)', 'execute'),
  'drop lifecycle: anon cannot execute launch_drop'
);

select ok(
  not has_function_privilege('authenticated', 'launch_drop(text)', 'execute'),
  'drop lifecycle: authenticated cannot execute launch_drop'
);

select ok(
  has_function_privilege('service_role', 'launch_drop(text)', 'execute'),
  'drop lifecycle: service_role can execute launch_drop'
);

select * from finish();
rollback;
