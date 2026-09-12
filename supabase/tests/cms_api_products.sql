-- pgTAP coverage for the CMS API (S1) RPCs: create_product_with_draft,
-- save_product_draft, publish_product_revision, set_piece_availability_guarded.
-- Run with `supabase test db`.

begin;
set local search_path to extensions, public, pg_temp;

select plan(20);

-- create_product_with_draft ---------------------------------------------------
select is(
  (create_product_with_draft('tap_cms_ceramic', 'ceramic', 'kubki', '99', '{"title":{"pl":"Test"}}'::jsonb, 'anna@studio.pl')).revision,
  1,
  'create_product_with_draft: first draft is revision 1'
);

select is(
  (select p.status from products p where p.id = 'tap_cms_ceramic'),
  'draft',
  'create_product_with_draft: product starts as draft'
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
    '{"category_slug":"kubki","num":"99","measure":"9x8","price_pln":12000,"price_eur":2800,"price_gbp":2400,"drop_id":null,"seo_title":null,"seo_description":null}'::jsonb
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

-- publish_product_revision — print, incomplete assets ---------------------------
select is(
  (create_product_with_draft('tap_cms_print', 'print', 'fine-art-prints', '98', '{"title":{"pl":"Print"}}'::jsonb, 'anna@studio.pl')).revision,
  1,
  'create_product_with_draft: print draft created'
);

select throws_ok(
  $$ select publish_product_revision(
       'tap_cms_print', 1, 'publish', 'anna@studio.pl',
       '[{"variant_key":"30x40:false:false:none","sku":"SKU1","print_area_width_px":100,"print_area_height_px":200}]'::jsonb,
       null, null
     ) $$,
  'print_assets_incomplete',
  'publish_product_revision: print with no ready proof is rejected'
);

select is(
  (select p.status from products p where p.id = 'tap_cms_print'),
  'draft',
  'publish_product_revision: rejected print publish rolls back to draft'
);

select is(
  (select count(*)::integer from product_variants pv where pv.product_id = 'tap_cms_print'),
  0,
  'publish_product_revision: rejected print publish rolls back variant inserts'
);

-- publish_product_revision — hide/archive ---------------------------------------
select is(
  (publish_product_revision('tap_cms_ceramic', 2, 'hide', 'anna@studio.pl', null, null, null))->'product'->>'status',
  'hidden',
  'publish_product_revision: hide flips status without touching variants'
);

-- set_piece_availability_guarded -------------------------------------------------
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
