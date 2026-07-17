-- pgTAP coverage for update_product_status_guarded: the activation readiness
-- decision, status write, published_at stamp, and audit entry share one DB
-- transaction. Run with `supabase test db`.

begin;
set local search_path to extensions, public, pg_temp;

select plan(11);

insert into products (id, type, category_slug, num, status) values
  ('tap_status_ready', 'print', 'fine-art-prints', '91', 'draft'),
  ('tap_status_missing', 'print', 'fine-art-prints', '92', 'draft'),
  ('tap_status_ceramic', 'ceramic', 'kubki', '93', 'draft');

insert into product_variants (
  product_id,
  variant_key,
  print_area_width_px,
  print_area_height_px
) values
  ('tap_status_ready', 'a', 100, 200),
  ('tap_status_missing', 'b', 100, 200);

insert into print_fulfilment_assets (
  id,
  product_id,
  revision,
  r2_key,
  sha256,
  content_type,
  width_px,
  height_px,
  byte_size,
  status
) values (
  '91000000-0000-0000-0000-000000000001',
  'tap_status_ready',
  'r1',
  'prints/tap_status_ready/r1/100x200-ready.jpg',
  'tap_status_ready_sha',
  'image/jpeg',
  100,
  200,
  123,
  'ready'
);

insert into print_variant_asset_assignments (product_id, variant_key, asset_id)
values ('tap_status_ready', 'a', '91000000-0000-0000-0000-000000000001');

select throws_ok(
  $$ select update_product_status_guarded('tap_status_unknown', 'active', null) $$,
  'product_not_found',
  'guarded status: unknown product is rejected'
);

select is(
  update_product_status_guarded('tap_status_missing', 'active', null)->'missing'->>0,
  'b',
  'guarded status: incomplete print response names the missing variant'
);

select is(
  (select p.status from products p where p.id = 'tap_status_missing'),
  'draft',
  'guarded status: incomplete print remains draft'
);

select is(
  update_product_status_guarded('tap_status_ready', 'active', 'anna@studio.pl')->>'ok',
  'true',
  'guarded status: ready print activates'
);

select is(
  (select p.status from products p where p.id = 'tap_status_ready'),
  'active',
  'guarded status: activation writes active status'
);

select ok(
  (select p.published_at is not null from products p where p.id = 'tap_status_ready'),
  'guarded status: first activation stamps published_at'
);

select is(
  (select cal.action || ':' || cal.actor_email
     from catalog_audit_log cal
    where cal.product_id = 'tap_status_ready'
    order by cal.created_at desc
    limit 1),
  'status:active:anna@studio.pl',
  'guarded status: activation audit records action and actor atomically'
);

select is(
  update_product_status_guarded('tap_status_ceramic', 'active', null)->>'ok',
  'true',
  'guarded status: ceramics do not require print coverage'
);

select ok(
  not has_function_privilege('anon', 'update_product_status_guarded(text,text,text)', 'execute'),
  'guarded status: anon cannot execute the RPC'
);

select ok(
  not has_function_privilege('authenticated', 'update_product_status_guarded(text,text,text)', 'execute'),
  'guarded status: authenticated cannot execute the RPC'
);

select ok(
  has_function_privilege('service_role', 'update_product_status_guarded(text,text,text)', 'execute'),
  'guarded status: service_role can execute the RPC'
);

select * from finish();
rollback;
