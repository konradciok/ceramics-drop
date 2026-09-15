-- pgTAP coverage for the database boundary that prevents a catalog seed/upsert
-- from publishing an unready print. Run with `supabase test db`.

begin;
set local search_path to extensions, public, pg_temp;

select plan(20);

select throws_like(
  $$ select backfill_catalog(null, '[]'::jsonb, '[]'::jsonb) $$,
  'catalog_backfill_arrays_required',
  'catalog backfill guard: atomic RPC rejects null structural payloads'
);

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

select throws_like(
  $$ insert into products (id, type, category_slug, num, status)
     values ('tap_backfill_candidate', 'print', 'fine-art-prints', '91', 'active')
     on conflict (id) do update set status = excluded.status $$,
  'print_assets_incomplete:%tap_backfill_candidate:<no_active_variants>%',
  'catalog backfill guard: direct upsert cannot bypass inactive-to-active readiness'
);

select is(
  (select status from products where id = 'tap_backfill_candidate'),
  'draft',
  'catalog backfill guard: rejected direct upsert leaves the print draft'
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

insert into products (id, type, category_slug, num, price_pln, status)
values ('tap_backfill_ceramic', 'ceramic', 'kubki', '93', 100, 'active');

select lives_ok(
  $$ insert into products (id, type, category_slug, num, price_pln, status)
     values ('tap_backfill_ceramic', 'ceramic', 'kubki', '93', 100, 'active')
     on conflict (id) do update set status = excluded.status $$,
  'catalog backfill guard: active ceramic upserts remain allowed'
);

select is(
  (select status from products where id = 'tap_backfill_ceramic'),
  'active',
  'catalog backfill guard: ceramic upsert preserves active status'
);

-- backfill_catalog() must skip any id the CMS has ever drafted/published
-- (S2b: 20260914140000_backfill_cms_ownership_guard.sql) --------------------
insert into products (id, type, category_slug, num, price_pln, status)
values ('tap_backfill_cms_owned', 'ceramic', 'kubki', '80', 100, 'active');

insert into product_media (product_id, url, alt, position, is_primary)
values ('tap_backfill_cms_owned', 'https://example.test/cms-owned-original.webp', null, 0, true);

-- Marks the id CMS-owned: any row in product_drafts, draft or published.
insert into product_drafts (product_id, revision, payload)
values ('tap_backfill_cms_owned', 1, '{"title":{"pl":"CMS-edited kubek"}}'::jsonb);

insert into products (id, type, category_slug, num, price_pln, status)
values ('tap_backfill_not_cms_owned', 'ceramic', 'kubki', '81', 100, 'active');

insert into product_media (product_id, url, alt, position, is_primary)
values ('tap_backfill_not_cms_owned', 'https://example.test/not-cms-owned-original.webp', null, 0, true);

create temporary table tap_backfill_result as
select backfill_catalog(
  jsonb_build_array(
    jsonb_build_object('id', 'tap_backfill_cms_owned', 'type', 'ceramic', 'category_slug', 'wazony', 'num', '80', 'measure', '', 'price_pln', 999, 'status', 'active'),
    jsonb_build_object('id', 'tap_backfill_not_cms_owned', 'type', 'ceramic', 'category_slug', 'wazony', 'num', '81', 'measure', '', 'price_pln', 999, 'status', 'active'),
    jsonb_build_object('id', 'tap_backfill_genuinely_new', 'type', 'ceramic', 'category_slug', 'kubki', 'num', '82', 'measure', '', 'price_pln', 111, 'status', 'active')
  ),
  '[]'::jsonb,
  jsonb_build_array(
    jsonb_build_object('product_id', 'tap_backfill_cms_owned', 'url', 'https://example.test/cms-owned-backfill-attempt.webp', 'alt', null, 'position', 0, 'is_primary', true),
    jsonb_build_object('product_id', 'tap_backfill_not_cms_owned', 'url', 'https://example.test/not-cms-owned-backfilled.webp', 'alt', null, 'position', 0, 'is_primary', true)
  )
) as result;

select is(
  (select category_slug from products where id = 'tap_backfill_cms_owned'),
  'kubki',
  'catalog backfill guard: a CMS-owned product''s category_slug is left untouched'
);

select is(
  (select price_pln from products where id = 'tap_backfill_cms_owned'),
  100,
  'catalog backfill guard: a CMS-owned product''s price_pln is left untouched'
);

select is(
  (select url from product_media where product_id = 'tap_backfill_cms_owned'),
  'https://example.test/cms-owned-original.webp',
  'catalog backfill guard: a CMS-owned product''s media is left untouched (not deleted+replaced)'
);

select is(
  (select category_slug from products where id = 'tap_backfill_not_cms_owned'),
  'wazony',
  'catalog backfill guard: a co-processed non-CMS-owned product IS updated (guard is selective, not global)'
);

select is(
  (select url from product_media where product_id = 'tap_backfill_not_cms_owned'),
  'https://example.test/not-cms-owned-backfilled.webp',
  'catalog backfill guard: a co-processed non-CMS-owned product''s media IS replaced'
);

select is(
  (select category_slug from products where id = 'tap_backfill_genuinely_new'),
  'kubki',
  'catalog backfill guard: a genuinely new id (never in product_drafts) still inserts via ON CONFLICT DO NOTHING'
);

select is(
  (select result -> 'skipped_cms_owned_ids' from tap_backfill_result),
  '["tap_backfill_cms_owned"]'::jsonb,
  'catalog backfill guard: the RPC reports exactly the skipped CMS-owned id(s)'
);

select * from finish();
rollback;
