-- pgTAP coverage for the catalog backfill RPC boundary: payload validation,
-- the ceramic-only products type, and the CMS-ownership guard. Run with
-- `supabase test db`.

begin;
set local search_path to extensions, public, pg_temp;

select plan(12);

select throws_like(
  $$ select backfill_catalog(null, '[]'::jsonb, '[]'::jsonb) $$,
  'catalog_backfill_arrays_required',
  'catalog backfill guard: atomic RPC rejects null structural payloads'
);

-- Prints left this store (2026-11): products is ceramic-only.
select throws_ok(
  $$ insert into products (id, type, category_slug, num, status)
     values ('tap_backfill_print', 'print', 'kubki', '90', 'draft') $$,
  '23514',
  null,
  'catalog backfill guard: a print product row is rejected (products_type_check)'
);

select throws_ok(
  $$ select backfill_catalog(
       jsonb_build_array(jsonb_build_object('id', 'tap_backfill_print_seed', 'type', 'print', 'category_slug', 'kubki', 'num', '91', 'measure', '', 'status', 'draft')),
       '[]'::jsonb,
       '[]'::jsonb
     ) $$,
  '23514',
  null,
  'catalog backfill guard: backfill_catalog cannot seed a print row'
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
