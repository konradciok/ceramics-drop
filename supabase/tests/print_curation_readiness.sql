-- pgTAP coverage for the bulk print-curation readiness assertion. The curation
-- migration calls this assertion before changing any product status/number, so
-- one incomplete active variant aborts the transaction instead of publishing a
-- partially fulfilment-ready catalogue.

begin;
set local search_path to extensions, public, pg_temp;

select plan(9);

insert into products (id, type, category_slug, num, price_pln, status) values
  ('tap_curation_ready',       'print', 'fine-art-prints', '91', null, 'draft'),
  ('tap_curation_inactive',    'print', 'fine-art-prints', '92', null, 'draft'),
  ('tap_curation_missing',     'print', 'fine-art-prints', '93', null, 'draft'),
  ('tap_curation_revoked',     'print', 'fine-art-prints', '94', null, 'draft'),
  ('tap_curation_mismatch',    'print', 'fine-art-prints', '95', null, 'draft'),
  ('tap_curation_wrong_owner', 'print', 'fine-art-prints', '96', null, 'draft');

insert into product_variants (
  product_id,
  variant_key,
  active,
  print_area_width_px,
  print_area_height_px
) values
  ('tap_curation_ready',       'a', true,  100, 200),
  ('tap_curation_inactive',    'a', false, 100, 200),
  ('tap_curation_missing',     'a', true,  100, 200),
  ('tap_curation_revoked',     'a', true,  100, 200),
  ('tap_curation_mismatch',    'a', true,  100, 200),
  ('tap_curation_wrong_owner', 'a', true,  100, 200);

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
) values
  (
    '92000000-0000-0000-0000-000000000001',
    'tap_curation_ready',
    'r1',
    'prints/tap_curation_ready/r1/100x200-ready.jpg',
    'tap_curation_ready_sha',
    'image/jpeg',
    100,
    200,
    123,
    'ready'
  ),
  (
    '92000000-0000-0000-0000-000000000002',
    'tap_curation_revoked',
    'r1',
    'prints/tap_curation_revoked/r1/100x200-revoked.jpg',
    'tap_curation_revoked_sha',
    'image/jpeg',
    100,
    200,
    123,
    'revoked'
  ),
  (
    '92000000-0000-0000-0000-000000000003',
    'tap_curation_mismatch',
    'r1',
    'prints/tap_curation_mismatch/r1/101x200-ready.jpg',
    'tap_curation_mismatch_sha',
    'image/jpeg',
    101,
    200,
    123,
    'ready'
  );

insert into print_variant_asset_assignments (product_id, variant_key, asset_id) values
  ('tap_curation_ready',       'a', '92000000-0000-0000-0000-000000000001'),
  ('tap_curation_revoked',     'a', '92000000-0000-0000-0000-000000000002'),
  ('tap_curation_mismatch',    'a', '92000000-0000-0000-0000-000000000003'),
  ('tap_curation_wrong_owner', 'a', '92000000-0000-0000-0000-000000000001');

select lives_ok(
  $$ select assert_print_assets_ready(array['tap_curation_ready']) $$,
  'print curation readiness: a ready, assigned, dimension-matched active variant passes'
);

select throws_like(
  $$ select assert_print_assets_ready(array['tap_curation_inactive']) $$,
  'print_assets_incomplete:%tap_curation_inactive:<no_active_variants>%',
  'print curation readiness: a print with no active variants fails closed'
);

select throws_like(
  $$ select assert_print_assets_ready(array['tap_curation_missing']) $$,
  'print_assets_incomplete:%tap_curation_missing:a%',
  'print curation readiness: a missing assignment fails closed'
);

select throws_like(
  $$ select assert_print_assets_ready(array['tap_curation_revoked']) $$,
  'print_assets_incomplete:%tap_curation_revoked:a%',
  'print curation readiness: a revoked assigned asset fails closed'
);

select throws_like(
  $$ select assert_print_assets_ready(array['tap_curation_mismatch']) $$,
  'print_assets_incomplete:%tap_curation_mismatch:a%',
  'print curation readiness: a dimension mismatch fails closed'
);

select throws_like(
  $$ select assert_print_assets_ready(array['tap_curation_wrong_owner']) $$,
  'print_assets_incomplete:%tap_curation_wrong_owner:a%',
  'print curation readiness: an asset owned by another product fails closed'
);

select ok(
  not has_function_privilege('anon', 'assert_print_assets_ready(text[])', 'execute'),
  'print curation readiness: anon cannot execute the assertion'
);

select ok(
  not has_function_privilege('authenticated', 'assert_print_assets_ready(text[])', 'execute'),
  'print curation readiness: authenticated cannot execute the assertion'
);

select ok(
  has_function_privilege('service_role', 'assert_print_assets_ready(text[])', 'execute'),
  'print curation readiness: service_role can execute the assertion'
);

select * from finish();
rollback;
