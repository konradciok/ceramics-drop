-- pgTAP coverage for the CMS API (S1) RPCs: create_product_with_draft,
-- save_product_draft, publish_product_revision, set_piece_availability_guarded.
-- Run with `supabase test db`.

begin;
set local search_path to extensions, public, pg_temp;

select plan(32);

-- create_product_with_draft ---------------------------------------------------
select is(
  (create_product_with_draft('tap_cms_ceramic', 'ceramic', 'kubki', '99', '{"title":{"pl":"Test"},"pricePln":12000,"priceEur":2800,"priceGbp":2400}'::jsonb, 'anna@studio.pl')).revision,
  1,
  'create_product_with_draft: first draft is revision 1'
);

select is(
  (select p.status from products p where p.id = 'tap_cms_ceramic'),
  'draft',
  'create_product_with_draft: product starts as draft'
);

select is(
  (select p.price_pln from products p where p.id = 'tap_cms_ceramic'),
  120,
  'create_product_with_draft: writes the real ceramic price (minor units / 100) at creation, satisfying products_ceramic_price_present unconditionally'
);

select is(
  (select cal.action from catalog_audit_log cal where cal.product_id = 'tap_cms_ceramic' order by cal.created_at desc limit 1),
  'draft_saved',
  'create_product_with_draft: writes a draft_saved audit row'
);

-- save_product_draft -----------------------------------------------------------
select is(
  (save_product_draft('tap_cms_ceramic', 1, '{"title":{"pl":"Test v2"}}'::jsonb, 'anna@studio.pl')).revision,
  2,
  'save_product_draft: increments revision'
);

select throws_ok(
  $$ select save_product_draft('tap_cms_ceramic', 1, '{}'::jsonb, 'anna@studio.pl') $$,
  'revision_conflict',
  'save_product_draft: stale expectedRevision is rejected'
);

select throws_ok(
  $$ select save_product_draft('tap_cms_unknown', 0, '{}'::jsonb, 'anna@studio.pl') $$,
  'product_not_found',
  'save_product_draft: unknown product is rejected'
);

-- publish_product_revision — ceramic -------------------------------------------
select is(
  (publish_product_revision(
    'tap_cms_ceramic', 2, 'publish', 'anna@studio.pl', null,
    '[{"url":"https://example.test/a.webp","alt":null,"position":0,"is_primary":true}]'::jsonb,
    '{"category_slug":"kubki","num":"99","measure":"9x8","price_pln":12000,"price_eur":2800,"price_gbp":2400,"drop_id":null,"title":"CMS Kubek","description":"CMS description","seo_title":null,"seo_description":null}'::jsonb
  ))->'product'->>'status',
  'active',
  'publish_product_revision: ceramic publish activates the product'
);

select is(
  (select p.published_revision from products p where p.id = 'tap_cms_ceramic'),
  2,
  'publish_product_revision: stamps published_revision'
);

select ok(
  (select ps.status = 'available' from piece_state ps where ps.product_id = 'tap_cms_ceramic'),
  'publish_product_revision: creates a piece_state row for a new ceramic'
);

select is(
  (select count(*)::integer from product_media pm where pm.product_id = 'tap_cms_ceramic'),
  1,
  'publish_product_revision: replaces product_media from the draft'
);

-- publish_product_revision — ceramic drop_id default + title/description (S2a) --
select is(
  (select p.drop_id from products p where p.id = 'tap_cms_ceramic'),
  'drop-1',
  'publish_product_revision: a first-ever ceramic publish with no explicit drop_id defaults to the active drop'
);

select is(
  (select p.title from products p where p.id = 'tap_cms_ceramic'),
  'CMS Kubek',
  'publish_product_revision: materializes title from the structural payload'
);

select is(
  (select p.description from products p where p.id = 'tap_cms_ceramic'),
  'CMS description',
  'publish_product_revision: materializes description from the structural payload'
);

-- An empty-string drop_id (cms-ceramics's blank text field submits '', not
-- null) must default exactly like an absent one, not violate the drop_id FK.
select is(
  (create_product_with_draft('tap_cms_empty_drop', 'ceramic', 'kubki', '94', '{"title":{"pl":"Empty Drop"},"pricePln":8000,"priceEur":1600,"priceGbp":1400}'::jsonb, 'anna@studio.pl')).revision,
  1,
  'create_product_with_draft: fourth ceramic draft created for the empty-string drop_id test'
);

select is(
  (publish_product_revision(
    'tap_cms_empty_drop', 1, 'publish', 'anna@studio.pl', null,
    '[{"url":"https://example.test/d.webp","alt":null,"position":0,"is_primary":true}]'::jsonb,
    '{"category_slug":"kubki","num":"94","measure":"9x8","price_pln":8000,"price_eur":1600,"price_gbp":1400,"drop_id":"","title":"Empty Drop","description":"Empty drop desc","seo_title":null,"seo_description":null}'::jsonb
  ))->'product'->>'drop_id',
  'drop-1',
  'publish_product_revision: an empty-string drop_id (not null) still defaults to the active drop instead of violating the FK'
);

select is(
  (create_product_with_draft('tap_cms_no_drop', 'ceramic', 'kubki', '96', '{"title":{"pl":"No Drop"},"pricePln":10000,"priceEur":2000,"priceGbp":1800}'::jsonb, 'anna@studio.pl')).revision,
  1,
  'create_product_with_draft: second ceramic draft created for the no-active-drop test'
);

update drops set status = 'ended' where id = 'drop-1';

select throws_ok(
  $$ select publish_product_revision(
       'tap_cms_no_drop', 1, 'publish', 'anna@studio.pl', null,
       '[{"url":"https://example.test/b.webp","alt":null,"position":0,"is_primary":true}]'::jsonb,
       '{"category_slug":"kubki","num":"96","measure":"9x8","price_pln":10000,"price_eur":2000,"price_gbp":1800,"drop_id":null,"title":"No Drop","description":"No drop desc","seo_title":null,"seo_description":null}'::jsonb
     ) $$,
  'no_active_drop',
  'publish_product_revision: a first-ever ceramic publish with zero active drops and no explicit drop_id is rejected'
);

update drops set status = 'active' where id = 'drop-1';

select is(
  (publish_product_revision(
    'tap_cms_no_drop', 1, 'publish', 'anna@studio.pl', null,
    '[{"url":"https://example.test/b.webp","alt":null,"position":0,"is_primary":true}]'::jsonb,
    '{"category_slug":"kubki","num":"96","measure":"9x8","price_pln":10000,"price_eur":2000,"price_gbp":1800,"drop_id":null,"title":"No Drop","description":"No drop desc","seo_title":null,"seo_description":null}'::jsonb
  ))->'product'->>'status',
  'active',
  'publish_product_revision: the same publish succeeds once an active drop exists again'
);

-- Republish regression: an explicit drop_id set on first publish must survive
-- even after a DIFFERENT drop later becomes the active one.
select is(
  (create_product_with_draft('tap_cms_drop2', 'ceramic', 'kubki', '95', '{"title":{"pl":"Drop Two"},"pricePln":9000,"priceEur":1800,"priceGbp":1600}'::jsonb, 'anna@studio.pl')).revision,
  1,
  'create_product_with_draft: third ceramic draft created for the republish-preserves-drop_id test'
);

insert into drops (id, label, status, started_at) values ('tap_drop_2', 'Tap Drop 2', 'ended', now());

select is(
  (publish_product_revision(
    'tap_cms_drop2', 1, 'publish', 'anna@studio.pl', null,
    '[{"url":"https://example.test/c.webp","alt":null,"position":0,"is_primary":true}]'::jsonb,
    '{"category_slug":"kubki","num":"95","measure":"9x8","price_pln":9000,"price_eur":1800,"price_gbp":1600,"drop_id":"tap_drop_2","title":"Drop Two","description":"Drop two desc","seo_title":null,"seo_description":null}'::jsonb
  ))->'product'->>'drop_id',
  'tap_drop_2',
  'publish_product_revision: an explicit drop_id on first publish is honoured over the active drop'
);

select save_product_draft('tap_cms_drop2', 1, '{"title":{"pl":"Drop Two v2"}}'::jsonb, 'anna@studio.pl');

select is(
  (publish_product_revision(
    'tap_cms_drop2', 2, 'publish', 'anna@studio.pl', null,
    '[{"url":"https://example.test/c.webp","alt":null,"position":0,"is_primary":true}]'::jsonb,
    '{"category_slug":"kubki","num":"95","measure":"9x8","price_pln":9000,"price_eur":1800,"price_gbp":1600,"drop_id":null,"title":"Drop Two v2","description":"Drop two desc v2","seo_title":null,"seo_description":null}'::jsonb
  ))->'product'->>'drop_id',
  'tap_drop_2',
  'publish_product_revision: a republish with no explicit drop_id keeps the existing drop_id instead of re-picking the active one'
);

-- Republish with an EXPLICIT drop_id that differs from the existing one:
-- the explicit value must win outright, not just on a first-ever publish.
select save_product_draft('tap_cms_drop2', 2, '{"title":{"pl":"Drop Two v3"}}'::jsonb, 'anna@studio.pl');

select is(
  (publish_product_revision(
    'tap_cms_drop2', 3, 'publish', 'anna@studio.pl', null,
    '[{"url":"https://example.test/c.webp","alt":null,"position":0,"is_primary":true}]'::jsonb,
    '{"category_slug":"kubki","num":"95","measure":"9x8","price_pln":9000,"price_eur":1800,"price_gbp":1600,"drop_id":"drop-1","title":"Drop Two v3","description":"Drop two desc v3","seo_title":null,"seo_description":null}'::jsonb
  ))->'product'->>'drop_id',
  'drop-1',
  'publish_product_revision: an explicit drop_id on republish overrides the existing (different) drop_id'
);

-- create_product_with_draft — prints are retired (2026-11) ----------------------
select throws_ok(
  $$ select create_product_with_draft('tap_cms_print', 'print', 'kubki', '98', '{"title":{"pl":"Print"}}'::jsonb, 'anna@studio.pl') $$,
  'invalid_type',
  'create_product_with_draft: a print draft is rejected'
);

-- publish_product_revision — hide/archive ---------------------------------------
select is(
  (publish_product_revision('tap_cms_ceramic', 2, 'hide', 'anna@studio.pl', null, null, null))->'product'->>'status',
  'hidden',
  'publish_product_revision: hide flips status without touching variants'
);

-- set_piece_availability_guarded -------------------------------------------------
-- A genuine successful transition first: exercises the real UPDATE statement
-- (and its p_availability::piece_status cast — the invalid_availability and
-- reservation_active checks below all raise BEFORE reaching that UPDATE, so
-- none of them alone would catch a cast/assignment bug here).
select is(
  (set_piece_availability_guarded('tap_cms_ceramic', 'sold', false, 'anna@studio.pl'))->>'ok',
  'true',
  'set_piece_availability_guarded: a normal transition to sold succeeds'
);

select is(
  (select ps.status::text from piece_state ps where ps.product_id = 'tap_cms_ceramic'),
  'sold',
  'set_piece_availability_guarded: the piece_state row reflects the new status'
);

select throws_ok(
  $$ select set_piece_availability_guarded('tap_cms_ceramic', 'showroom', true, 'anna@studio.pl') $$,
  'invalid_availability',
  'set_piece_availability_guarded: only available|sold are accepted (showroom is the separate boolean)'
);

update piece_state set status = 'reserved', reserved_until = now() + interval '10 minutes' where product_id = 'tap_cms_ceramic';

select throws_ok(
  $$ select set_piece_availability_guarded('tap_cms_ceramic', 'sold', false, 'anna@studio.pl') $$,
  'reservation_active',
  'set_piece_availability_guarded: refuses to touch an actively reserved piece'
);

update piece_state set status = 'sold', reserved_until = null, order_id = gen_random_uuid() where product_id = 'tap_cms_ceramic';

select throws_ok(
  $$ select set_piece_availability_guarded('tap_cms_ceramic', 'available', false, 'anna@studio.pl') $$,
  'reservation_active',
  'set_piece_availability_guarded: refuses to revert an online-sold piece'
);

-- privileges ----------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'publish_product_revision(text,integer,text,text,jsonb,jsonb,jsonb)', 'execute'),
  'publish_product_revision: anon cannot execute'
);

select ok(
  has_function_privilege('service_role', 'publish_product_revision(text,integer,text,text,jsonb,jsonb,jsonb)', 'execute'),
  'publish_product_revision: service_role can execute'
);

select * from finish();
rollback;
