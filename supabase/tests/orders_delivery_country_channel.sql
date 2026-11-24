-- pgTAP tests for 20261124120000_orders_delivery_country_channel.sql:
-- the five shipping-from-Spain columns on orders, their checks, and
-- prepare_balance_order persisting the three checkout-time columns.
-- Run locally with:
--   supabase test db
-- Every assertion runs inside the BEGIN/ROLLBACK below, so no fixture data
-- persists. Synthetic `tap_dlv_*` rows keep fixtures clear of real data.

begin;
set local search_path to extensions, public, pg_temp;

select plan(16);

-- ── Fixtures ────────────────────────────────────────────────────────────────
-- A paid gift-card order and its card, so prepare_balance_order can hold it.
insert into orders (id, payment_intent_id, currency, subtotal, shipping, total, shipping_method, status, fulfilment_type)
values ('22222222-2222-2222-2222-222222222222', 'tap_dlv_pi_src', 'pln', 20000, 0, 20000, 'odbior', 'paid', 'giftcard');
update gift_card_settings set spending_enabled = true;
select issue_gift_card('22222222-2222-2222-2222-222222222222', 'TAP-DLV-CARD');

-- ── 1. Columns ─────────────────────────────────────────────────────────────
select has_column('public', 'orders', 'delivery_country', 'orders.delivery_country exists');
select has_column('public', 'orders', 'shipping_channel', 'orders.shipping_channel exists');
select has_column('public', 'orders', 'delivery_point', 'orders.delivery_point exists');
select has_column('public', 'orders', 'tracking_url', 'orders.tracking_url exists');
select has_column('public', 'orders', 'shipment_attempt', 'orders.shipment_attempt exists');

select is(
  (select shipment_attempt from orders where id = '22222222-2222-2222-2222-222222222222'),
  0,
  'shipment_attempt defaults to 0'
);

-- ── 2. Checks ──────────────────────────────────────────────────────────────
select throws_ok(
  $$ update orders set delivery_country = 'es' where id = '22222222-2222-2222-2222-222222222222' $$,
  '23514', null, 'delivery_country must be two upper-case letters'
);
select throws_ok(
  $$ update orders set shipping_channel = 'dhl' where id = '22222222-2222-2222-2222-222222222222' $$,
  '23514', null, 'shipping_channel accepts only the known channels'
);
select throws_ok(
  $$ update orders set tracking_url = 'http://example.invalid/t' where id = '22222222-2222-2222-2222-222222222222' $$,
  '23514', null, 'tracking_url must be https'
);
select throws_ok(
  $$ update orders set shipment_attempt = -1 where id = '22222222-2222-2222-2222-222222222222' $$,
  '23514', null, 'shipment_attempt cannot be negative'
);
select throws_ok(
  $$ update orders set delivery_point = '["ES009299"]'::jsonb where id = '22222222-2222-2222-2222-222222222222' $$,
  '23514', null, 'delivery_point must be a JSON object'
);
select lives_ok(
  $$ update orders
     set delivery_country = 'ES', shipping_channel = 'sendcloud',
         delivery_point = '{"id": "1234", "country": "ES"}'::jsonb,
         tracking_url = 'https://tracking.example.invalid/ES1', shipment_attempt = 1
     where id = '22222222-2222-2222-2222-222222222222' $$,
  'valid values pass every check'
);

-- ── 3. prepare_balance_order ───────────────────────────────────────────────
-- Non-ceramic line (variant set) so no piece reservation is involved.
select prepare_balance_order(
  jsonb_build_object(
    'id', '33333333-3333-3333-3333-333333333333',
    'currency', 'pln', 'subtotal', 10000, 'shipping', 2000, 'total', 12000,
    'shipping_method', 'paczkomat', 'delivery_method', 'paczkomat', 'fulfilment_type', 'inpost',
    'email', 'tap_dlv@example.invalid', 'receiver_first_name', 'Tap', 'receiver_last_name', 'Dlv',
    'receiver_phone', '+34600000000', 'inpost_target_point', 'ES009299', 'locale', 'es',
    'delivery_country', 'ES', 'shipping_channel', 'sendcloud',
    'delivery_point', jsonb_build_object('id', '1234', 'code', 'ES009299', 'country', 'ES')
  ),
  '[{"product_id": "tap_dlv_item", "unit_price": 10000, "variant": {"kind": "legacy"}}]'::jsonb,
  'TAP-DLV-CARD', repeat('a', 64), 50
);

select is(
  (select delivery_country from orders where id = '33333333-3333-3333-3333-333333333333'),
  'ES',
  'prepare_balance_order persists delivery_country'
);
select is(
  (select shipping_channel from orders where id = '33333333-3333-3333-3333-333333333333'),
  'sendcloud',
  'prepare_balance_order persists shipping_channel'
);
select is(
  (select delivery_point ->> 'code' from orders where id = '33333333-3333-3333-3333-333333333333'),
  'ES009299',
  'prepare_balance_order persists delivery_point'
);

-- Today's callers send none of the new keys: the columns stay NULL.
select prepare_balance_order(
  jsonb_build_object(
    'id', '44444444-4444-4444-4444-444444444444',
    'currency', 'pln', 'subtotal', 4000, 'shipping', 2000, 'total', 6000,
    'shipping_method', 'paczkomat', 'delivery_method', 'paczkomat', 'fulfilment_type', 'inpost',
    'email', 'tap_dlv@example.invalid', 'receiver_first_name', 'Tap', 'receiver_last_name', 'Dlv',
    'receiver_phone', '+48600000000', 'inpost_target_point', 'KRA010', 'locale', 'pl'
  ),
  '[{"product_id": "tap_dlv_item2", "unit_price": 4000, "variant": {"kind": "legacy"}}]'::jsonb,
  'TAP-DLV-CARD', repeat('b', 64), 50
);

select ok(
  (select delivery_country is null and shipping_channel is null and delivery_point is null
   from orders where id = '44444444-4444-4444-4444-444444444444'),
  'prepare_balance_order without the new keys leaves them NULL'
);

select * from finish();
rollback;
