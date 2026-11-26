-- pgTAP tests for transfer_reservation (the payment-step "Zmień" hand-over).
-- Run locally with `supabase test db`. Everything rolls back; synthetic
-- `tap_tr_*` product ids keep the fixtures clear of real stock.

begin;
set local search_path to extensions, public, pg_temp;

select plan(9);

-- Order A holds two live pieces, one expired piece; another order holds one.
insert into piece_state (product_id, status, order_id, reserved_until) values
  ('tap_tr_1', 'reserved', '00000000-0000-4000-8000-00000000000a', now() + interval '5 minutes'),
  ('tap_tr_2', 'reserved', '00000000-0000-4000-8000-00000000000a', now() + interval '5 minutes'),
  ('tap_tr_3', 'reserved', '00000000-0000-4000-8000-00000000000a', now() - interval '1 minute'),
  ('tap_tr_4', 'reserved', '00000000-0000-4000-8000-0000000000cc', now() + interval '5 minutes');

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

select is(
  transfer_reservation('00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000a', 900),
  2,
  'swapped arguments move the hold back'
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
