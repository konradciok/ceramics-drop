-- pgTAP tests for the gift-card additions to promo_codes (20260904120000)
-- and the legacy-gift-card cutover that retires that mechanism
-- (20260909160000_legacy_gift_card_cutover.sql).
-- Run locally with:
--   supabase test db
-- Every assertion runs inside the BEGIN/ROLLBACK below, so no fixture data
-- persists. Synthetic `tap_gc_*` order/promo rows keep fixtures clear of
-- real data. NOT executed against any live/remote project by this change —
-- author-only verification, run it locally before trusting the migration.

begin;
set local search_path to extensions, public, pg_temp;

select plan(8);

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

-- 2. Post-cutover (20260909160000), the legacy promo-code gift-card mechanism
--    is retired: an ACTIVE gift-card-shaped row can never be inserted again —
--    balance-based gift_cards is the only issuance path now.
select throws_ok(
  $$ insert into promo_codes
       (code, kind, percent, amount_pln, amount_eur, amount_gbp, applies_to, active,
        max_redemptions, source, source_order_id, created_by, updated_by)
     values
       ('TAP_GC_ACTIVE', 'fixed', null, 50000, 12000, 10000, 'all', true,
        1, 'gift_card', null, 'system:gift-card', 'system:gift-card')
  $$,
  'P0001',
  'gift_card_balance_required',
  'inserting an active gift-card-shaped promo row is rejected post-cutover'
);

-- 3. source is constrained to the two known values (unrelated to the
--    cutover guard — still enforced by the original CHECK constraint).
select throws_ok(
  $$ insert into promo_codes (code, kind, percent, source) values ('TAP_GC_BAD', 'percent', 10, 'bogus') $$,
  '23514',
  null,
  'an unknown source value is rejected by the CHECK constraint'
);

-- 4. An INACTIVE gift-card-shaped row still inserts — this is exactly the
--    shape the cutover migration itself produces for historical codes
--    (`update promo_codes set active = false where source = 'gift_card'`).
select lives_ok(
  $$ insert into promo_codes
       (code, kind, percent, amount_pln, amount_eur, amount_gbp, applies_to, active,
        max_redemptions, source, source_order_id, created_by, updated_by)
     values
       ('TAP_GC_LEGACY', 'fixed', null, 50000, 12000, 10000, 'all', false,
        1, 'gift_card', null, 'system:gift-card', 'system:gift-card')
  $$,
  'a historical (inactive) gift-card-shaped promo row still inserts'
);

-- 5. Reactivating that historical row (active=false -> true) is rejected —
--    the balance already lives in gift_cards, so this code can never spend
--    again on its own.
select throws_ok(
  $$ update promo_codes set active = true where code = 'TAP_GC_LEGACY' $$,
  'P0001',
  'gift_card_balance_required',
  'reactivating a legacy gift-card code is rejected'
);

-- 6. Renaming a legacy gift-card row's code is rejected — its history
--    (gift_cards.source_order_id, gift_card_ledger) must stay traceable to a
--    stable code/order_id.
select throws_ok(
  $$ update promo_codes set code = 'TAP_GC_RENAMED' where code = 'TAP_GC_LEGACY' $$,
  'P0001',
  'legacy_gift_card_history_is_immutable',
  'renaming a legacy gift-card code is rejected'
);

-- 7. A no-op update (touching an unrelated column, active/code/source_order_id
--    unchanged) is still allowed — the immutability guard only fires on the
--    identity-bearing columns above.
select lives_ok(
  $$ update promo_codes set max_redemptions = 2 where code = 'TAP_GC_LEGACY' $$,
  'updating a non-identity column on a legacy gift-card row is still allowed'
);

-- 8. orders.fulfilment_type accepts the new 'giftcard' value (the fixture
--    insert above already exercises this; assert explicitly too).
select is(
  (select fulfilment_type from orders where id = '11111111-1111-1111-1111-111111111111'),
  'giftcard',
  'orders.fulfilment_type accepts giftcard'
);

select * from finish();
rollback;
