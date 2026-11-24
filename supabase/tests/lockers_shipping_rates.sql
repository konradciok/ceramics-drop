-- pgTAP tests for 20261124180000_lockers_shipping_rates.sql: the 'lockers'
-- shipping-rate resource (zone es / eu × PLN / EUR / GBP), seeded and
-- published at revision 1, and publishable through the existing RPCs.
-- Run locally with:
--   supabase test db
-- Every assertion runs inside the BEGIN/ROLLBACK below.

begin;
set local search_path to extensions, public, pg_temp;

select plan(9);

select is(
  shipping_rate_field_keys('lockers'),
  array['es_pln', 'es_eur', 'es_gbp', 'eu_pln', 'eu_eur', 'eu_gbp'],
  'lockers: zone-major publishable keys'
);

select is(
  shipping_rate_field_keys('domestic'),
  array['paczkomat_pln', 'kurier_pln', 'odbior_pln', 'paczkomat_eur', 'kurier_eur', 'odbior_eur', 'paczkomat_gbp', 'kurier_gbp', 'odbior_gbp'],
  'lockers migration leaves the domestic keys unchanged'
);

select is(
  array_length(shipping_rate_field_keys('international'), 1),
  56,
  'lockers migration leaves the 56 international keys unchanged'
);

select is(
  (select published_revision from shipping_rates where id = 'lockers'),
  1,
  'lockers: published at revision 1'
);

select is(
  (select shipping_rate_draft_values(d.payload) from shipping_rate_drafts d where d.rate_id = 'lockers' and d.revision = 1),
  '{"es_pln": "43", "es_eur": "10", "es_gbp": "9", "eu_pln": "65", "eu_eur": "15", "eu_gbp": "13"}'::jsonb,
  'lockers: owner-approved seed (Spain 43 zł / 10 € / 9 £, rest 65 zł / 15 € / 13 £)'
);

select is(
  (select count(*)::integer from catalog_audit_log where product_id = 'lockers' and action = 'published'),
  1,
  'lockers: the seed is audited as published'
);

-- Round trip through the CMS RPCs: save revision 2, publish it.
select is(
  (select d.revision from save_shipping_rate_draft(
    'lockers', 1,
    '{"fields":[{"key":"es_pln","value":"45"},{"key":"es_eur","value":"10.5"},{"key":"es_gbp","value":"9"},{"key":"eu_pln","value":"65"},{"key":"eu_eur","value":"15"},{"key":"eu_gbp","value":"13"}]}'::jsonb,
    'tap@example.invalid') d),
  2,
  'lockers: a draft saves as revision 2'
);

select lives_ok(
  $$ select publish_shipping_rate_revision('lockers', 2, 'tap@example.invalid') $$,
  'lockers: a complete, valid draft publishes'
);

select throws_ok(
  $$ select publish_shipping_rate_revision('lockers', (select save_shipping_rate_draft('lockers', 2,
       '{"fields":[{"key":"es_pln","value":"45"}]}'::jsonb, 'tap@example.invalid')).revision,
       'tap@example.invalid') $$,
  'P0001', 'shipping_rates_invalid',
  'lockers: a draft missing zone keys cannot be published'
);

select * from finish();
rollback;
