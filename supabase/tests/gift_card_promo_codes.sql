-- pgTAP tests for the gift-card additions to promo_codes (20260904120000).
-- Run locally with:
--   supabase test db
-- Every assertion runs inside the BEGIN/ROLLBACK below, so no fixture data
-- persists. Synthetic `tap_gc_*` order/promo rows keep fixtures clear of
-- real data. NOT executed against any live/remote project by this change —
-- author-only verification, run it locally before trusting the migration.

begin;
set local search_path to extensions, public, pg_temp;

select plan(7);

-- ── Fixtures ────────────────────────────────────────────────────────────────
insert into orders (id, payment_intent_id, subtotal, shipping, total, shipping_method, status, fulfilment_type)
values ('11111111-1111-1111-1111-111111111111', 'tap_gc_pi_1', 50000, 0, 50000, 'odbior', 'paid', 'giftcard');

-- ── Tests ─────────────────────────────────────────────────────────────────
-- 1. Existing (pre-feature-shaped) promo rows default to source='admin' with
--    a NULL source_order_id — no behaviour change for the existing feature.
insert into promo_codes (code, kind, percent) values ('TAP_GC_ADMIN', 'percent', 10);

select is(
  (select source from promo_codes where code = 'TAP_GC_ADMIN'),
  'admin',
  'a plain promo insert defaults source to admin'
);

select is(
  (select source_order_id from promo_codes where code = 'TAP_GC_ADMIN'),
  null,
  'a plain promo insert leaves source_order_id NULL'
);

-- 2. A gift-card-shaped insert succeeds and round-trips its fields.
select lives_ok(
  $$ insert into promo_codes
       (code, kind, percent, amount_pln, amount_eur, amount_gbp, applies_to, active,
        max_redemptions, source, source_order_id, created_by, updated_by)
     values
       ('TAP_GC_CODE1', 'fixed', null, 50000, 12000, 10000, 'all', true,
        1, 'gift_card', '11111111-1111-1111-1111-111111111111', 'system:gift-card', 'system:gift-card')
  $$,
  'a gift-card-shaped promo row inserts successfully'
);

-- 3. source is constrained to the two known values.
select throws_ok(
  $$ insert into promo_codes (code, kind, percent, source) values ('TAP_GC_BAD', 'percent', 10, 'bogus') $$,
  '23514',
  null,
  'an unknown source value is rejected by the CHECK constraint'
);

-- 4. Idempotent minting: a SECOND gift-card code for the SAME order is
--    rejected by the partial unique index (the webhook route's mint-once
--    guarantee).
select throws_ok(
  $$ insert into promo_codes
       (code, kind, percent, amount_pln, amount_eur, amount_gbp, applies_to, active,
        max_redemptions, source, source_order_id, created_by, updated_by)
     values
       ('TAP_GC_CODE2', 'fixed', null, 50000, 12000, 10000, 'all', true,
        1, 'gift_card', '11111111-1111-1111-1111-111111111111', 'system:gift-card', 'system:gift-card')
  $$,
  '23505',
  null,
  'a second gift-card mint for the same order_id is rejected (idempotent mint)'
);

-- 5. Revocation reuses the existing active flag — no new RPC.
update promo_codes set active = false where code = 'TAP_GC_CODE1';
select is(
  (select active from promo_codes where code = 'TAP_GC_CODE1'),
  false,
  'revoking a gift-card code is a plain active=false update (no new RPC)'
);

-- 6. orders.fulfilment_type accepts the new 'giftcard' value (the fixture
--    insert above already exercises this; assert explicitly too).
select is(
  (select fulfilment_type from orders where id = '11111111-1111-1111-1111-111111111111'),
  'giftcard',
  'orders.fulfilment_type accepts giftcard'
);

select * from finish();
rollback;
