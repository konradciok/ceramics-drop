-- pgTAP coverage for 20260913230000_ceramic_category_check.sql:
-- products_ceramic_category_valid rejects a ceramic row whose category_slug
-- isn't one of the 9 valid ceramic slugs (in particular 'fine-art-prints',
-- the CodeRabbit-flagged case from the CMS API S1 review), while leaving
-- print rows untouched. Run with `supabase test db`. Every assertion runs
-- inside the BEGIN/ROLLBACK below, so no fixture data persists. Mirrors
-- rpc_hardening.sql's M-4 price-guard test structure.

begin;
set local search_path to extensions, public, pg_temp;

select plan(4);

-- A ceramic row can never legitimately be category_slug='fine-art-prints' —
-- that slug is reserved for print rows (see AGENTS.md's CategorySlug note).
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

-- The CHECK is ceramic-only — a print row's category_slug='fine-art-prints'
-- (the only value prints ever use) is unaffected.
select lives_ok(
  $$ insert into products (id, type, category_slug, num, status)
     values ('tap_cat_print', 'print', 'fine-art-prints', '99', 'draft') $$,
  'a print row with category_slug=''fine-art-prints'' is unaffected by the ceramic-only CHECK'
);

select * from finish();
rollback;
