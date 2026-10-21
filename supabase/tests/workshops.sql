-- pgTAP tests for the workshops booking RPCs (20261021120000_workshops.sql).
-- Run locally with: supabase test db
-- Every assertion runs inside the BEGIN/ROLLBACK below, so no fixture data
-- persists. Synthetic `tap_*` ids keep the fixtures clear of the seeded calendar.

begin;
set local search_path to extensions, public, pg_temp;

select plan(16);

-- ── Fixtures ────────────────────────────────────────────────────────────────
insert into workshops (id, slug, price_cents, duration_min, capacity, cover)
  values ('tap_w', 'tap-workshop', 5000, 120, 3, '{"src":"/x.webp","w":1,"h":1}');
insert into workshop_sessions (id, workshop_id, starts_at, lang) values
  ('tap_s1', 'tap_w', (now() at time zone 'Atlantic/Canary') + interval '7 days', 'pl'),
  ('tap_past', 'tap_w', (now() at time zone 'Atlantic/Canary') - interval '1 day', 'pl');

-- ── Holds ───────────────────────────────────────────────────────────────────
select is(
  (select status from workshop_hold_seats('tap_s1', 2, 'TAP-AAAA-AAAA', 'pl', 15)),
  'held',
  'a hold within capacity succeeds'
);
select is(
  (select seats_left from workshop_sessions_public where id = 'tap_s1'),
  1,
  'held seats count as taken'
);
select throws_ok(
  $$ select workshop_hold_seats('tap_s1', 2, 'TAP-BBBB-BBBB', 'pl', 15) $$,
  'P0001', 'sold_out',
  'a hold beyond the remaining seats is refused'
);
select throws_ok(
  $$ select workshop_hold_seats('tap_past', 1, 'TAP-CCCC-CCCC', 'pl', 15) $$,
  'P0001', 'not_found',
  'a session that already started cannot be held'
);
select throws_ok(
  $$ select workshop_hold_seats('tap_s1', 7, 'TAP-DDDD-DDDD', 'pl', 15) $$,
  'P0001', 'invalid_seats',
  'more than 6 seats per booking is refused'
);

-- A lapsed hold frees its seats.
update workshop_bookings set hold_expires_at = now() - interval '1 minute' where ref = 'TAP-AAAA-AAAA';
select is(
  (select seats_left from workshop_sessions_public where id = 'tap_s1'),
  3,
  'a lapsed hold no longer counts'
);

-- ── Payment confirmation ────────────────────────────────────────────────────
-- Someone else takes all three seats; the lapsed booking's payment then lands.
select is(
  (select status from workshop_hold_seats('tap_s1', 3, 'TAP-EEEE-EEEE', 'pl', 15)),
  'held',
  'the freed seats can be held by someone else'
);
select is(
  workshop_confirm_payment('TAP-AAAA-AAAA', 'pi_tap_a'),
  'refund_needed',
  'a late payment on a full session must be refunded'
);
select is(
  (select stripe_payment_intent from workshop_bookings where ref = 'TAP-AAAA-AAAA'),
  'pi_tap_a',
  'the late payment intent is recorded for the refund'
);
select is(workshop_confirm_payment('TAP-EEEE-EEEE', 'pi_tap_e'), 'paid', 'a payment on a live hold confirms it');
select is(workshop_confirm_payment('TAP-EEEE-EEEE', 'pi_tap_e'), 'already_paid', 'a duplicate confirmation is a no-op');

update workshop_bookings set status = 'refunded' where ref = 'TAP-AAAA-AAAA';
select is(workshop_confirm_payment('TAP-AAAA-AAAA', 'pi_tap_a'), 'already_refunded', 'a refunded booking stays refunded');
select is(workshop_confirm_payment('TAP-0000-0000', 'pi_x'), 'not_found', 'an unknown ref is reported');

-- ── Access ──────────────────────────────────────────────────────────────────
select ok(
  not has_function_privilege('anon', 'workshop_hold_seats(text, integer, text, text, integer)', 'execute')
    and not has_function_privilege('authenticated', 'workshop_hold_seats(text, integer, text, text, integer)', 'execute'),
  'anon/authenticated cannot hold seats'
);
select ok(
  not has_function_privilege('anon', 'workshop_confirm_payment(text, text)', 'execute')
    and not has_function_privilege('authenticated', 'workshop_confirm_payment(text, text)', 'execute'),
  'anon/authenticated cannot confirm payments'
);
select ok(
  (select bool_and(relrowsecurity) from pg_class
    where relname in ('workshops', 'workshop_sessions', 'workshop_bookings') and relnamespace = 'public'::regnamespace),
  'RLS is on for every workshops table'
);

select * from finish();
rollback;
