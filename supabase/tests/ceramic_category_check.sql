-- pgTAP coverage for 20260913230000_ceramic_category_check.sql:
-- products_ceramic_category_valid rejects a ceramic row whose category_slug
-- isn't one of the valid ceramic slugs (11 since 20261123110000) (in particular 'fine-art-prints',
-- the retired print shop's slug and the CodeRabbit-flagged case from the CMS
-- API S1 review). Run with `supabase test db`. Every assertion runs
-- inside the BEGIN/ROLLBACK below, so no fixture data persists. Mirrors
-- rpc_hardening.sql's M-4 price-guard test structure.

begin;
set local search_path to extensions, public, pg_temp;

select plan(5);

-- A ceramic row can never be category_slug='fine-art-prints' — the retired
-- print shop's slug, never one of the nine ceramic families.
select throws_ok(
  $$ insert into products (id, type, category_slug, num, price_pln, status)
     values ('tap_cat_fap', 'ceramic', 'fine-art-prints', '99', 100, 'draft') $$,
  '23514',
  null, -- skip matching the (locale-dependent) message text; errcode is enough
  'a ceramic row with category_slug=''fine-art-prints'' is rejected (23514 check_violation)'
);

-- Any other value outside the 9-slug ceramic vocabulary is equally invalid —
-- the CHECK is an allow-list, not a single-value blocklist.
select throws_ok(
  $$ insert into products (id, type, category_slug, num, price_pln, status)
     values ('tap_cat_typo', 'ceramic', 'kubkiii', '99', 100, 'draft') $$,
  '23514',
  null,
  'a ceramic row with a typo''d category_slug is rejected (23514 check_violation)'
);

-- A genuinely valid ceramic category is unaffected.
select lives_ok(
  $$ insert into products (id, type, category_slug, num, price_pln, status)
     values ('tap_cat_valid', 'ceramic', 'kubki', '99', 100, 'draft') $$,
  'a ceramic row with a valid category_slug (''kubki'') is accepted'
);

-- The families added in 20261123110000_new_plate_categories.sql are accepted.
select lives_ok(
  $$ insert into products (id, type, category_slug, num, price_pln, status)
     values ('tap_cat_oval', 'ceramic', 'talerze-owalne', '99', 100, 'draft') $$,
  'a ceramic row with category_slug ''talerze-owalne'' is accepted'
);
select lives_ok(
  $$ insert into products (id, type, category_slug, num, price_pln, status)
     values ('tap_cat_small', 'ceramic', 'talerze-male', '99', 100, 'draft') $$,
  'a ceramic row with category_slug ''talerze-male'' is accepted'
);

select * from finish();
rollback;
