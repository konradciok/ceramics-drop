-- pgTAP coverage for update_product_status_guarded: the status write,
-- published_at stamp, and audit entry share one DB transaction. Run with
-- `supabase test db`.

begin;
set local search_path to extensions, public, pg_temp;

select plan(9);

insert into products (id, type, category_slug, num, price_pln, status) values
  ('tap_status_ceramic', 'ceramic', 'kubki', '93', 100, 'draft');

select throws_ok(
  $$ select update_product_status_guarded('tap_status_unknown', 'active', null) $$,
  'product_not_found',
  'guarded status: unknown product is rejected'
);

select throws_ok(
  $$ select update_product_status_guarded('tap_status_ceramic', 'published', null) $$,
  'invalid_product_status',
  'guarded status: an unknown status value is rejected'
);

select is(
  update_product_status_guarded('tap_status_ceramic', 'active', 'anna@studio.pl')->>'ok',
  'true',
  'guarded status: a ceramic activates'
);

select is(
  (select p.status from products p where p.id = 'tap_status_ceramic'),
  'active',
  'guarded status: activation writes active status'
);

select ok(
  (select p.published_at is not null from products p where p.id = 'tap_status_ceramic'),
  'guarded status: first activation stamps published_at'
);

select is(
  (select cal.action || ':' || cal.actor_email
     from catalog_audit_log cal
    where cal.product_id = 'tap_status_ceramic'
    order by cal.created_at desc
    limit 1),
  'status:active:anna@studio.pl',
  'guarded status: activation audit records action and actor atomically'
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
