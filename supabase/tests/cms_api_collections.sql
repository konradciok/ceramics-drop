-- pgTAP coverage for the CMS API collections RPCs: create_collection_with_draft,
-- save_collection_draft, publish_collection_revision, restore_collection_draft.
-- Also regression-checks that the catalog_audit_log relaxation (product_id now
-- nullable, collection_id added) didn't break the existing product-audit write
-- path used by create_product_with_draft/save_product_draft.
-- Run with `supabase test db`.

begin;
set local search_path to extensions, public, pg_temp;

select plan(40);

-- Fixture: a real product row for product_ref_invalid's "valid id" half.
-- print (not ceramic) so no price is required — products_ceramic_price_present
-- only constrains type='ceramic' rows.
insert into products (id, type, category_slug, num) values ('tap_col_prod_1', 'print', 'fine-art-prints', '1');

-- create_collection_with_draft -------------------------------------------------
select is(
  (create_collection_with_draft(
    'tap_col_main',
    '{"name":"Spring Collection","fields":[{"key":"title","label":"Title","type":"text","value":"Wiosna","locale":"pl","sourceLocale":"pl"},{"key":"products","label":"Products","type":"productIds","value":"tap_col_prod_1","locale":"none","sourceLocale":"none"}]}'::jsonb,
    'anna@studio.pl'
  )).revision,
  1,
  'create_collection_with_draft: first draft is revision 1'
);

select is(
  (select c.published_revision from collections c where c.id = 'tap_col_main'),
  null::integer,
  'create_collection_with_draft: a new collection has no published_revision'
);

select is(
  (select cal.action from catalog_audit_log cal where cal.collection_id = 'tap_col_main' order by cal.created_at desc limit 1),
  'draft_saved',
  'create_collection_with_draft: writes a draft_saved audit row'
);

-- save_collection_draft ---------------------------------------------------------
select is(
  (save_collection_draft(
    'tap_col_main',
    1,
    '{"name":"Spring Collection","fields":[{"key":"title","label":"Title","type":"text","value":"Wiosna 2","locale":"pl","sourceLocale":"pl"},{"key":"products","label":"Products","type":"productIds","value":"tap_col_prod_1","locale":"none","sourceLocale":"none"}]}'::jsonb,
    'anna@studio.pl'
  )).revision,
  2,
  'save_collection_draft: increments revision'
);

select throws_ok(
  $$ select save_collection_draft('tap_col_main', 1, '{}'::jsonb, 'anna@studio.pl') $$,
  'revision_conflict',
  'save_collection_draft: stale expectedRevision is rejected'
);

select throws_ok(
  $$ select save_collection_draft('tap_col_unknown', 0, '{}'::jsonb, 'anna@studio.pl') $$,
  'collection_not_found',
  'save_collection_draft: unknown collection is rejected'
);

-- publish_collection_revision — success path -------------------------------------
select is(
  (publish_collection_revision('tap_col_main', 2, 'anna@studio.pl'))->>'ok',
  'true',
  'publish_collection_revision: publishing the current revision succeeds'
);

select is(
  (select c.published_revision from collections c where c.id = 'tap_col_main'),
  2,
  'publish_collection_revision: stamps published_revision'
);

select ok(
  (select c.published_at is not null from collections c where c.id = 'tap_col_main'),
  'publish_collection_revision: stamps published_at'
);

-- Filtered on action (not just "order by created_at desc limit 1"): the whole
-- file runs inside one pgTAP transaction, and catalog_audit_log.created_at
-- defaults to now() == transaction_timestamp(), which is frozen for the
-- entire transaction — every audit row written anywhere in this file shares
-- the exact same created_at. By this point 'tap_col_main' already has two
-- earlier 'draft_saved' rows (create + save) tied on created_at with this
-- new row, so "latest by created_at" is not decidable and returns whichever
-- row Postgres's tie-break happens to pick — filtering on the expected
-- action is the only way to assert this deterministically, and still fails
-- (NULL vs 'published') if publish_collection_revision omits the audit
-- write entirely.
select is(
  (select cal.action from catalog_audit_log cal
    where cal.collection_id = 'tap_col_main' and cal.action = 'published'
    order by cal.created_at desc limit 1),
  'published',
  'publish_collection_revision: writes a published audit row'
);

-- publish_collection_revision — error paths --------------------------------------
select throws_ok(
  $$ select publish_collection_revision('tap_col_main', 1, 'anna@studio.pl') $$,
  'revision_conflict',
  'publish_collection_revision: stale expectedRevision is rejected'
);

select throws_ok(
  $$ select publish_collection_revision('tap_col_unknown', 0, 'anna@studio.pl') $$,
  'collection_not_found',
  'publish_collection_revision: unknown collection is rejected'
);

-- draft_required: a collection with zero saved drafts (bypasses the RPC,
-- which always creates revision 1 — inserted directly to reach this state).
insert into collections (id) values ('tap_col_no_draft');

select throws_ok(
  $$ select publish_collection_revision('tap_col_no_draft', 0, 'anna@studio.pl') $$,
  'draft_required',
  'publish_collection_revision: publishing with no draft ever saved is rejected'
);

select is(
  (create_collection_with_draft(
    'tap_col_blank_pl',
    '{"name":"Blank Polish","fields":[{"key":"title","label":"Title","type":"text","value":"   ","locale":"pl","sourceLocale":"pl"}]}'::jsonb,
    'anna@studio.pl'
  )).revision,
  1,
  'create_collection_with_draft: blank-pl-field fixture created'
);

select throws_ok(
  $$ select publish_collection_revision('tap_col_blank_pl', 1, 'anna@studio.pl') $$,
  'missing_polish',
  'publish_collection_revision: a blank (whitespace-only) pl field value is rejected'
);

select is(
  (create_collection_with_draft(
    'tap_col_no_pl',
    '{"name":"No Polish","fields":[{"key":"title","label":"Title","type":"text","value":"Spring","locale":"en","sourceLocale":"en"}]}'::jsonb,
    'anna@studio.pl'
  )).revision,
  1,
  'create_collection_with_draft: no-pl-field fixture created'
);

select throws_ok(
  $$ select publish_collection_revision('tap_col_no_pl', 1, 'anna@studio.pl') $$,
  'missing_polish',
  'publish_collection_revision: a draft with no pl field at all is rejected'
);

select is(
  (create_collection_with_draft(
    'tap_col_bad_product',
    '{"name":"Bad Product Ref","fields":[{"key":"title","label":"Title","type":"text","value":"Ok","locale":"pl","sourceLocale":"pl"},{"key":"products","label":"Products","type":"productIds","value":"tap_col_prod_1, tap_col_prod_missing","locale":"none","sourceLocale":"none"}]}'::jsonb,
    'anna@studio.pl'
  )).revision,
  1,
  'create_collection_with_draft: invalid-product-ref fixture created'
);

select throws_ok(
  $$ select publish_collection_revision('tap_col_bad_product', 1, 'anna@studio.pl') $$,
  'product_ref_invalid',
  'publish_collection_revision: a productIds CSV containing an id absent from products is rejected'
);

-- An empty productIds CSV (no products in the collection) is valid, not an
-- error — Global Constraint 11.
select is(
  (create_collection_with_draft(
    'tap_col_empty_products',
    '{"name":"Empty Products","fields":[{"key":"title","label":"Title","type":"text","value":"Ok","locale":"pl","sourceLocale":"pl"},{"key":"products","label":"Products","type":"productIds","value":"","locale":"none","sourceLocale":"none"}]}'::jsonb,
    'anna@studio.pl'
  )).revision,
  1,
  'create_collection_with_draft: empty-products fixture created'
);

select is(
  (publish_collection_revision('tap_col_empty_products', 1, 'anna@studio.pl'))->>'ok',
  'true',
  'publish_collection_revision: an empty productIds CSV publishes successfully'
);

-- restore_collection_draft — success path -----------------------------------------
select is(
  (restore_collection_draft('tap_col_main', 2, 1, 'anna@studio.pl')).revision,
  3,
  'restore_collection_draft: copies the source revision into a brand-new revision'
);

select is(
  (select cd.payload from collection_drafts cd where cd.collection_id = 'tap_col_main' and cd.revision = 3),
  '{"name":"Spring Collection","fields":[{"key":"title","label":"Title","type":"text","value":"Wiosna","locale":"pl","sourceLocale":"pl"},{"key":"products","label":"Products","type":"productIds","value":"tap_col_prod_1","locale":"none","sourceLocale":"none"}]}'::jsonb,
  'restore_collection_draft: the new revision carries the source revision''s exact payload'
);

select is(
  (select c.published_revision from collections c where c.id = 'tap_col_main'),
  2,
  'restore_collection_draft: never touches published_revision'
);

-- Same fix as the publish assertion above: filter on the expected action
-- rather than "order by created_at desc limit 1", since 'tap_col_main' now
-- has 3 earlier rows (2x draft_saved, 1x published) all tied on created_at
-- with this new row inside the one transaction the whole file runs in.
select is(
  (select cal.action from catalog_audit_log cal
    where cal.collection_id = 'tap_col_main' and cal.action = 'restored'
    order by cal.created_at desc limit 1),
  'restored',
  'restore_collection_draft: writes a restored audit row'
);

-- restore_collection_draft — error paths -------------------------------------------
select throws_ok(
  $$ select restore_collection_draft('tap_col_unknown', 0, 1, 'anna@studio.pl') $$,
  'collection_not_found',
  'restore_collection_draft: unknown collection is rejected'
);

select throws_ok(
  $$ select restore_collection_draft('tap_col_main', 1, 1, 'anna@studio.pl') $$,
  'revision_conflict',
  'restore_collection_draft: stale expectedRevision is rejected'
);

select throws_ok(
  $$ select restore_collection_draft('tap_col_main', 3, 99, 'anna@studio.pl') $$,
  'source_revision_not_found',
  'restore_collection_draft: an unknown source revision is rejected'
);

-- privileges ------------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'create_collection_with_draft(text,jsonb,text)', 'execute'),
  'create_collection_with_draft: anon cannot execute'
);

select ok(
  has_function_privilege('service_role', 'create_collection_with_draft(text,jsonb,text)', 'execute'),
  'create_collection_with_draft: service_role can execute'
);

select ok(
  not has_function_privilege('anon', 'save_collection_draft(text,integer,jsonb,text)', 'execute'),
  'save_collection_draft: anon cannot execute'
);

select ok(
  has_function_privilege('service_role', 'save_collection_draft(text,integer,jsonb,text)', 'execute'),
  'save_collection_draft: service_role can execute'
);

select ok(
  not has_function_privilege('anon', 'publish_collection_revision(text,integer,text)', 'execute'),
  'publish_collection_revision: anon cannot execute'
);

select ok(
  has_function_privilege('service_role', 'publish_collection_revision(text,integer,text)', 'execute'),
  'publish_collection_revision: service_role can execute'
);

select ok(
  not has_function_privilege('anon', 'restore_collection_draft(text,integer,integer,text)', 'execute'),
  'restore_collection_draft: anon cannot execute'
);

select ok(
  has_function_privilege('service_role', 'restore_collection_draft(text,integer,integer,text)', 'execute'),
  'restore_collection_draft: service_role can execute'
);

-- regression: catalog_audit_log's relaxed product_id / new collection_id /
-- num_nonnulls check must not break the existing product-audit write path.
select is(
  (create_product_with_draft('tap_col_regress_product', 'ceramic', 'kubki', '99', '{"title":{"pl":"Regress"},"pricePln":12000,"priceEur":2800,"priceGbp":2400}'::jsonb, 'anna@studio.pl')).revision,
  1,
  'regression: create_product_with_draft still works after the catalog_audit_log alteration'
);

select is(
  (select cal.product_id from catalog_audit_log cal where cal.product_id = 'tap_col_regress_product' order by cal.created_at desc limit 1),
  'tap_col_regress_product',
  'regression: the product audit row keeps product_id set'
);

select is(
  (select cal.collection_id from catalog_audit_log cal where cal.product_id = 'tap_col_regress_product' order by cal.created_at desc limit 1),
  null::text,
  'regression: the product audit row leaves collection_id null, satisfying num_nonnulls(product_id, collection_id) = 1'
);

select is(
  (save_product_draft('tap_col_regress_product', 1, '{"title":{"pl":"Regress v2"}}'::jsonb, 'anna@studio.pl')).revision,
  2,
  'regression: save_product_draft still works after the catalog_audit_log alteration'
);

select * from finish();
rollback;
