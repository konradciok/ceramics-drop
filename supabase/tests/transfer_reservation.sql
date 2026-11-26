-- pgTAP tests for transfer_reservation (the payment-step "Zmień" hand-over).
-- Run locally with `supabase test db`. Everything rolls back; synthetic
-- `tap_tr_*` product ids keep the fixtures clear of real stock.

begin;
set local search_path to extensions, public, pg_temp;

select plan(12);

-- Order A holds two live pieces, one expired piece; another order holds one.
insert into piece_state (product_id, status, order_id, reserved_until) values
  ('tap_tr_1', 'reserved', '00000000-0000-4000-8000-00000000000a', now() + interval '5 minutes'),
  ('tap_tr_2', 'reserved', '00000000-0000-4000-8000-00000000000a', now() + interval '5 minutes'),
  ('tap_tr_3', 'reserved', '00000000-0000-4000-8000-00000000000a', now() - interval '1 minute'),
  ('tap_tr_4', 'reserved', '00000000-0000-4000-8000-0000000000cc', now() + interval '5 minutes');

-- Order A exists (the pending checkout being edited); so does an unrelated order D.
insert into orders (id, payment_intent_id, subtotal, shipping, total, shipping_method, status) values
  ('00000000-0000-4000-8000-00000000000a', 'tap_tr_pi_a', 10000, 0, 10000, 'odbior', 'pending'),
  ('00000000-0000-4000-8000-00000000000d', 'tap_tr_pi_d', 10000, 0, 10000, 'odbior', 'pending');

select is(
  transfer_reservation('00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b', 900),
  2,
  'moves only the live holds of the old order'
);

select is(
  (select count(*)::int from piece_state where order_id = '00000000-0000-4000-8000-00000000000b' and status = 'reserved'),
  2,
  'the new attempt owns them, still reserved (never available in between)'
);

select ok(
  (select bool_and(reserved_until > now() + interval '14 minutes')
     from piece_state where order_id = '00000000-0000-4000-8000-00000000000b'),
  'the hold is renewed to the TTL'
);

select is(
  (select order_id from piece_state where product_id = 'tap_tr_3'),
  '00000000-0000-4000-8000-00000000000a'::uuid,
  'an expired hold stays behind'
);

select is(
  (select order_id from piece_state where product_id = 'tap_tr_4'),
  '00000000-0000-4000-8000-0000000000cc'::uuid,
  'another order''s hold is untouched'
);

select is(
  reserve_pieces(array['tap_tr_1', 'tap_tr_2'], '00000000-0000-4000-8000-00000000000b', 900),
  array[]::text[],
  'reserve_pieces accepts the moved hold as the new attempt''s own'
);

select throws_ok(
  $$ select transfer_reservation('00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000d', 900) $$,
  'transfer_target_exists',
  'refuses to move a hold under an order that already exists (it would be sold with that order)'
);

select is(
  restore_transferred_reservation('00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000a', 900),
  2,
  'restore moves the hold back to the order it came from'
);

select throws_ok(
  $$ select restore_transferred_reservation('00000000-0000-4000-8000-00000000000d', '00000000-0000-4000-8000-00000000000a', 900) $$,
  'transfer_target_exists',
  'restore refuses an attempt id that became an order'
);

select ok(
  not has_function_privilege('anon', 'public.restore_transferred_reservation(uuid, uuid, integer)', 'execute'),
  'anon cannot call restore'
);

select throws_ok(
  $$ select transfer_reservation('00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000a', 900) $$,
  'invalid_transfer',
  'refuses a transfer onto the same order'
);

select ok(
  not has_function_privilege('anon', 'public.transfer_reservation(uuid, uuid, integer)', 'execute'),
  'anon cannot call it'
);

select * from finish();
rollback;
