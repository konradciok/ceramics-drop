-- pgTAP coverage for the database boundary that prevents a catalog seed/upsert
-- from publishing an unready print. Run with `supabase test db`.

begin;
set local search_path to extensions, public, pg_temp;

select plan(8);

insert into products (id, type, category_slug, num)
values ('tap_backfill_default', 'print', 'fine-art-prints', '90');

insert into products (id, type, category_slug, num, status)
values ('tap_backfill_candidate', 'print', 'fine-art-prints', '91', 'draft');

select is(
  (select status from products where id = 'tap_backfill_default'),
  'draft',
  'catalog backfill guard: a print omitted status defaults to draft'
);

select throws_like(
  $$ insert into products (id, type, category_slug, num, status)
     values ('tap_backfill_explicit', 'print', 'fine-art-prints', '92', 'active') $$,
  'print_assets_incomplete:%',
  'catalog backfill guard: an explicit active print insert is rejected'
);

select throws_like(
  $$ update products set status = 'active' where id = 'tap_backfill_candidate' $$,
  'print_assets_incomplete:%tap_backfill_candidate:<no_active_variants>%',
  'catalog backfill guard: a direct unready activation is rejected'
);

select is(
  (select status from products where id = 'tap_backfill_candidate'),
  'draft',
  'catalog backfill guard: rejected direct activation leaves the print draft'
);

select is(
  update_product_status_guarded('tap_backfill_candidate', 'active', null)->>'error',
  'print_assets_incomplete',
  'catalog backfill guard: guarded activation rejects zero active variants'
);

select is(
  (select status from products where id = 'tap_backfill_candidate'),
  'draft',
  'catalog backfill guard: rejected guarded activation leaves the print draft'
);

insert into product_variants (
  product_id,
  variant_key,
  active,
  print_area_width_px,
  print_area_height_px
) values ('tap_backfill_candidate', 'ready', true, 100, 200);

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
  '93000000-0000-0000-0000-000000000001',
  'tap_backfill_candidate',
  'r1',
  'prints/tap_backfill_candidate/r1/100x200-ready.jpg',
  'tap_backfill_candidate_sha',
  'image/jpeg',
  100,
  200,
  123,
  'ready'
);

insert into print_variant_asset_assignments (product_id, variant_key, asset_id)
values (
  'tap_backfill_candidate',
  'ready',
  '93000000-0000-0000-0000-000000000001'
);

select is(
  update_product_status_guarded('tap_backfill_candidate', 'active', null)->>'ok',
  'true',
  'catalog backfill guard: guarded activation succeeds after readiness exists'
);

select is(
  (select status from products where id = 'tap_backfill_candidate'),
  'active',
  'catalog backfill guard: successful guarded activation writes active status'
);

select * from finish();
rollback;
