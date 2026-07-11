-- pgTAP tests for the print-fulfilment-asset readiness gate: the
-- `publish_print_asset_revision` RPC (atomic revision publish with exact
-- variant coverage + per-asset readiness/dimension checks) and the
-- `guard_print_asset_immutable` trigger. Run locally with:
--   supabase test db        (wraps each file; pgTAP must be enabled)
-- Every assertion runs inside the BEGIN/ROLLBACK below, so no fixture data
-- persists. Synthetic `tap_*` ids keep the fixtures clear of real stock.
-- Mirrors private-sale.sql structure.

begin;
-- pgTAP lives in `extensions` on Supabase; tables/RPCs in `public`. Missing
-- schemas in search_path are ignored, so this is safe across hosted and local.
set local search_path to extensions, public, pg_temp;

select plan(30);

-- ── Fixtures ────────────────────────────────────────────────────────────────
-- Every print product has active variants seeded with print-area pixels (the
-- dimension contract the RPC enforces). Assets carry explicit uuids so
-- assertions can name them; r2_key is unique per row (content-addressed).

-- tap_p1: happy path / repeat / incomplete-coverage cases (2 variants a, b).
insert into products (id, type, category_slug, num) values ('tap_p1', 'print', 'fine-art-prints', '01');
insert into product_variants (product_id, variant_key, print_area_width_px, print_area_height_px) values
  ('tap_p1', 'a', 3600, 4800),
  ('tap_p1', 'b', 3600, 4800);
insert into print_fulfilment_assets (id, product_id, revision, r2_key, sha256, content_type, width_px, height_px, byte_size, status) values
  ('a0000000-0000-0000-0000-000000000001', 'tap_p1', 'r1', 'prints/tap_p1/r1/3600x4800-a.jpg', 'sha_a', 'image/jpeg', 3600, 4800, 123456, 'ready'),
  ('a0000000-0000-0000-0000-000000000002', 'tap_p1', 'r1', 'prints/tap_p1/r1/3600x4800-b.jpg', 'sha_b', 'image/jpeg', 3600, 4800, 123456, 'ready');

-- tap_p2 / tap_p2b: wrong-product asset (asset owned by a different product).
insert into products (id, type, category_slug, num) values
  ('tap_p2',  'print', 'fine-art-prints', '02'),
  ('tap_p2b', 'print', 'fine-art-prints', '03');
insert into product_variants (product_id, variant_key, print_area_width_px, print_area_height_px) values
  ('tap_p2', 'a', 3600, 4800);
insert into print_fulfilment_assets (id, product_id, revision, r2_key, sha256, content_type, width_px, height_px, byte_size, status) values
  ('b0000000-0000-0000-0000-000000000001', 'tap_p2b', 'r1', 'prints/tap_p2b/r1/3600x4800.jpg', 'sha_p2', 'image/jpeg', 3600, 4800, 123456, 'ready');

-- tap_p3 / tap_p3n: dimension mismatch (wrong dims, and a null print area).
insert into products (id, type, category_slug, num) values
  ('tap_p3',  'print', 'fine-art-prints', '04'),
  ('tap_p3n', 'print', 'fine-art-prints', '05');
insert into product_variants (product_id, variant_key, print_area_width_px, print_area_height_px) values
  ('tap_p3',  'a', 3600, 4800),
  ('tap_p3n', 'n', null, null);
insert into print_fulfilment_assets (id, product_id, revision, r2_key, sha256, content_type, width_px, height_px, byte_size, status) values
  ('c0000000-0000-0000-0000-000000000001', 'tap_p3',  'r1', 'prints/tap_p3/r1/4000x4000.jpg',  'sha_d1', 'image/jpeg', 4000, 4000, 123456, 'ready'),
  ('c0000000-0000-0000-0000-000000000002', 'tap_p3n', 'r1', 'prints/tap_p3n/r1/3600x4800.jpg', 'sha_d2', 'image/jpeg', 3600, 4800, 123456, 'ready');

-- tap_p4: asset-not-ready (staged / retired / revoked).
insert into products (id, type, category_slug, num) values ('tap_p4', 'print', 'fine-art-prints', '06');
insert into product_variants (product_id, variant_key, print_area_width_px, print_area_height_px) values
  ('tap_p4', 'a', 3600, 4800);
insert into print_fulfilment_assets (id, product_id, revision, r2_key, sha256, content_type, width_px, height_px, byte_size, status) values
  ('d0000000-0000-0000-0000-000000000001', 'tap_p4', 'r1', 'prints/tap_p4/r1/staged.jpg',  'sha_s', 'image/jpeg', 3600, 4800, 123456, 'staged'),
  ('d0000000-0000-0000-0000-000000000002', 'tap_p4', 'r1', 'prints/tap_p4/r1/retired.jpg', 'sha_r', 'image/jpeg', 3600, 4800, 123456, 'retired'),
  ('d0000000-0000-0000-0000-000000000003', 'tap_p4', 'r1', 'prints/tap_p4/r1/revoked.jpg', 'sha_v', 'image/jpeg', 3600, 4800, 123456, 'revoked');

-- tap_p5: atomic rollback (an initial good publish, then a failing re-publish).
insert into products (id, type, category_slug, num) values ('tap_p5', 'print', 'fine-art-prints', '07');
insert into product_variants (product_id, variant_key, print_area_width_px, print_area_height_px) values
  ('tap_p5', 'a', 3600, 4800),
  ('tap_p5', 'b', 3600, 4800);
insert into print_fulfilment_assets (id, product_id, revision, r2_key, sha256, content_type, width_px, height_px, byte_size, status) values
  ('e0000000-0000-0000-0000-000000000001', 'tap_p5', 'r1', 'prints/tap_p5/r1/a.jpg',  'sha_5a', 'image/jpeg', 3600, 4800, 123456, 'ready'),
  ('e0000000-0000-0000-0000-000000000002', 'tap_p5', 'r1', 'prints/tap_p5/r1/b.jpg',  'sha_5b', 'image/jpeg', 3600, 4800, 123456, 'ready'),
  ('e0000000-0000-0000-0000-000000000003', 'tap_p5', 'r2', 'prints/tap_p5/r2/bad.jpg', 'sha_5c', 'image/jpeg', 3600, 4800, 123456, 'staged'),
  ('e0000000-0000-0000-0000-000000000004', 'tap_p5', 'r2', 'prints/tap_p5/r2/a.jpg',  'sha_5d', 'image/jpeg', 3600, 4800, 123456, 'ready');

-- tap_p6: immutability trigger (one ready asset, one staged asset).
insert into products (id, type, category_slug, num) values ('tap_p6', 'print', 'fine-art-prints', '08');
insert into print_fulfilment_assets (id, product_id, revision, r2_key, sha256, content_type, width_px, height_px, byte_size, status) values
  ('f0000000-0000-0000-0000-000000000001', 'tap_p6', 'r1', 'prints/tap_p6/r1/ready.jpg',  'sha_6r', 'image/jpeg', 3600, 4800, 123456, 'ready'),
  ('f0000000-0000-0000-0000-000000000002', 'tap_p6', 'r1', 'prints/tap_p6/r1/staged.jpg', 'sha_6s', 'image/jpeg', 3600, 4800, 123456, 'staged');

-- tap_pc: a ceramic product for the product_not_found (type guard) check.
insert into products (id, type, category_slug, num) values ('tap_pc', 'ceramic', 'kubki', '99');
insert into product_variants (product_id, variant_key) values ('tap_pc', 'default');

-- ── Tests ───────────────────────────────────────────────────────────────────

-- content_type CHECK: an invalid MIME is rejected at insert, before it can
-- ever reach staging/publish — a typo here must fail loudly at write time,
-- not later at publish or route-serve time.
select throws_ok(
  $$ insert into print_fulfilment_assets (product_id, revision, r2_key, sha256, content_type, width_px, height_px, byte_size, status)
     values ('tap_p1', 'r1', 'prints/tap_p1/r1/bad-mime.jpg', 'sha_bad', 'image/jpg', 3600, 4800, 123456, 'staged') $$,
  '23514',
  null, -- skip matching the (locale-dependent) message text; errcode is enough
  'print_fulfilment_assets: an invalid content_type is rejected by the CHECK constraint'
);

-- product_not_found: a non-print product is rejected by the `type = 'print'
-- ` lock (step 1 of the RPC, before any assignment is examined).
select throws_ok(
  $$ select publish_print_asset_revision('tap_pc', 'r1', '[]'::jsonb) $$,
  'product_not_found',
  'publish: non-print product raises product_not_found'
);

-- Scenario 1 (happy path): exact coverage with ready + dim-matched assets.
select is(
  (select assigned_count from publish_print_asset_revision(
    'tap_p1', 'r1',
    '[{"variant_key":"a","asset_id":"a0000000-0000-0000-0000-000000000001"},{"variant_key":"b","asset_id":"a0000000-0000-0000-0000-000000000002"}]'::jsonb)),
  2,
  'publish: exact coverage returns assigned_count = active variant count'
);

-- The assignment for variant a landed on its asset.
select is(
  (select asset_id::text from print_variant_asset_assignments
     where product_id = 'tap_p1' and variant_key = 'a'),
  'a0000000-0000-0000-0000-000000000001',
  'publish: assignment row written for variant a'
);

-- First publish writes a catalog_audit_log row (action, before, after.revision).
select is(
  (select action from catalog_audit_log
     where product_id = 'tap_p1'
     order by created_at desc limit 1),
  'print_asset_publish',
  'publish: writes catalog_audit_log with print_asset_publish action'
);

select is(
  (select before from catalog_audit_log
     where product_id = 'tap_p1'
     order by created_at asc limit 1),
  '[]'::jsonb,
  'publish: first audit before snapshot is empty assignment set'
);

select is(
  (select after->>'revision' from catalog_audit_log
     where product_id = 'tap_p1'
     order by created_at desc limit 1),
  'r1',
  'publish: audit after.revision matches p_revision'
);

select is(
  jsonb_array_length(
    (select after->'assignments' from catalog_audit_log
       where product_id = 'tap_p1'
       order by created_at desc limit 1)),
  2,
  'publish: audit after.assignments carries the full assignment set'
);

-- Re-publishing the same revision replaces cleanly.
select lives_ok(
  $$ select publish_print_asset_revision(
       'tap_p1', 'r1',
       '[{"variant_key":"a","asset_id":"a0000000-0000-0000-0000-000000000001"},{"variant_key":"b","asset_id":"a0000000-0000-0000-0000-000000000002"}]'::jsonb) $$,
  'publish: re-publishing the same revision is idempotent'
);

select is(
  (select count(*)::int from print_variant_asset_assignments where product_id = 'tap_p1'),
  2,
  'publish: repeat publish leaves exactly the active variant count'
);

-- Scenario 2 (incomplete mapping): missing, extra, and duplicate variant keys.
select throws_ok(
  $$ select publish_print_asset_revision(
       'tap_p1', 'r1',
       '[{"variant_key":"a","asset_id":"a0000000-0000-0000-0000-000000000001"}]'::jsonb) $$,
  'assignment_mismatch',
  'publish: a missing active variant raises assignment_mismatch'
);

select throws_ok(
  $$ select publish_print_asset_revision(
       'tap_p1', 'r1',
       '[{"variant_key":"a","asset_id":"a0000000-0000-0000-0000-000000000001"},{"variant_key":"b","asset_id":"a0000000-0000-0000-0000-000000000002"},{"variant_key":"c","asset_id":"a0000000-0000-0000-0000-000000000001"}]'::jsonb) $$,
  'assignment_mismatch',
  'publish: an extra variant key raises assignment_mismatch'
);

-- Duplicate 'a' but full {a,b} coverage → total(3) != distinct(2), no
-- missing/extra → exercises the duplicate branch of assignment_mismatch.
select throws_ok(
  $$ select publish_print_asset_revision(
       'tap_p1', 'r1',
       '[{"variant_key":"a","asset_id":"a0000000-0000-0000-0000-000000000001"},{"variant_key":"a","asset_id":"a0000000-0000-0000-0000-000000000001"},{"variant_key":"b","asset_id":"a0000000-0000-0000-0000-000000000002"}]'::jsonb) $$,
  'assignment_mismatch',
  'publish: a duplicate variant key raises assignment_mismatch'
);

-- Scenario 3 (wrong product): asset exists but belongs to another product.
select throws_ok(
  $$ select publish_print_asset_revision(
       'tap_p2', 'r1',
       '[{"variant_key":"a","asset_id":"b0000000-0000-0000-0000-000000000001"}]'::jsonb) $$,
  'wrong_product',
  'publish: an asset owned by another product raises wrong_product'
);

-- Scenario 4 (dimension mismatch): asset dims differ from the variant print area.
select throws_ok(
  $$ select publish_print_asset_revision(
       'tap_p3', 'r1',
       '[{"variant_key":"a","asset_id":"c0000000-0000-0000-0000-000000000001"}]'::jsonb) $$,
  'dimension_mismatch',
  'publish: an asset whose dims differ from the print area raises dimension_mismatch'
);

-- A ready asset against a variant whose print_area_*_px is null also fails:
-- `3600 is distinct from null` is true, so the gate is fail-closed.
select throws_ok(
  $$ select publish_print_asset_revision(
       'tap_p3n', 'r1',
       '[{"variant_key":"n","asset_id":"c0000000-0000-0000-0000-000000000002"}]'::jsonb) $$,
  'dimension_mismatch',
  'publish: a ready asset against a null print-area variant raises dimension_mismatch'
);

-- Scenario 4b (revision mismatch): assets tagged r1 cannot publish as r2.
select throws_ok(
  $$ select publish_print_asset_revision(
       'tap_p1', 'r2',
       '[{"variant_key":"a","asset_id":"a0000000-0000-0000-0000-000000000001"},{"variant_key":"b","asset_id":"a0000000-0000-0000-0000-000000000002"}]'::jsonb) $$,
  'revision_mismatch',
  'publish: assets whose revision differs from p_revision raise revision_mismatch'
);

-- Scenario 4c (invalid asset_id): malformed uuid rejected before cast.
select throws_ok(
  $$ select publish_print_asset_revision(
       'tap_p1', 'r1',
       '[{"variant_key":"a","asset_id":"not-a-uuid"},{"variant_key":"b","asset_id":"a0000000-0000-0000-0000-000000000002"}]'::jsonb) $$,
  'invalid_asset_id',
  'publish: a malformed asset_id raises invalid_asset_id'
);

-- Scenario 5 (asset not ready): staged / retired / revoked are all rejected.
select throws_ok(
  $$ select publish_print_asset_revision(
       'tap_p4', 'r1',
       '[{"variant_key":"a","asset_id":"d0000000-0000-0000-0000-000000000001"}]'::jsonb) $$,
  'asset_not_ready',
  'publish: a staged asset raises asset_not_ready'
);

select throws_ok(
  $$ select publish_print_asset_revision(
       'tap_p4', 'r1',
       '[{"variant_key":"a","asset_id":"d0000000-0000-0000-0000-000000000002"}]'::jsonb) $$,
  'asset_not_ready',
  'publish: a retired asset raises asset_not_ready'
);

select throws_ok(
  $$ select publish_print_asset_revision(
       'tap_p4', 'r1',
       '[{"variant_key":"a","asset_id":"d0000000-0000-0000-0000-000000000003"}]'::jsonb) $$,
  'asset_not_ready',
  'publish: a revoked asset raises asset_not_ready'
);

-- Scenario 6 (atomic swap / rollback): first publish succeeds, then a
-- re-publish whose 2nd assignment is not-ready must throw AND leave the prior
-- assignment set intact. The RPC validates everything (steps 1–3) before the
-- swap (step 4), so a failing publish never reaches the delete — the prior
-- assignment set is preserved by construction.
select lives_ok(
  $$ select publish_print_asset_revision(
       'tap_p5', 'r1',
       '[{"variant_key":"a","asset_id":"e0000000-0000-0000-0000-000000000001"},{"variant_key":"b","asset_id":"e0000000-0000-0000-0000-000000000002"}]'::jsonb) $$,
  'publish: initial good publish of tap_p5 succeeds'
);

select throws_ok(
  $$ select publish_print_asset_revision(
       'tap_p5', 'r2',
       '[{"variant_key":"a","asset_id":"e0000000-0000-0000-0000-000000000004"},{"variant_key":"b","asset_id":"e0000000-0000-0000-0000-000000000003"}]'::jsonb) $$,
  'asset_not_ready',
  'publish: a failing re-publish raises before swapping'
);

-- The prior assignment for variant b is still the r1 asset (rollback worked).
select is(
  (select asset_id::text from print_variant_asset_assignments
     where product_id = 'tap_p5' and variant_key = 'b'),
  'e0000000-0000-0000-0000-000000000002',
  'publish: a failed swap leaves the prior assignment intact'
);

-- Scenario 7 (immutability + status transitions + staged→ready).
-- (a) mutating a ready asset's content columns is blocked by the trigger.
select throws_ok(
  $$ update print_fulfilment_assets set r2_key = 'prints/tap_p6/r1/mutated.jpg' where id = 'f0000000-0000-0000-0000-000000000001' $$,
  'asset_immutable',
  'trigger: changing a ready asset r2_key raises asset_immutable'
);

select throws_ok(
  $$ update print_fulfilment_assets set width_px = 9999 where id = 'f0000000-0000-0000-0000-000000000001' $$,
  'asset_immutable',
  'trigger: changing a ready asset dimension raises asset_immutable'
);

-- (b) a ready → retired status transition is allowed.
select lives_ok(
  $$ update print_fulfilment_assets set status = 'retired' where id = 'f0000000-0000-0000-0000-000000000001' $$,
  'trigger: ready -> retired status transition is allowed'
);

-- (c) retired assets stay content-immutable (historical order fulfilment).
select throws_ok(
  $$ update print_fulfilment_assets set r2_key = 'prints/tap_p6/r1/retired-mutated.jpg' where id = 'f0000000-0000-0000-0000-000000000001' $$,
  'asset_immutable',
  'trigger: changing a retired asset r2_key raises asset_immutable'
);

-- (d) a staged → ready promotion is allowed.
select lives_ok(
  $$ update print_fulfilment_assets set status = 'ready' where id = 'f0000000-0000-0000-0000-000000000002' $$,
  'trigger: staged -> ready promotion is allowed'
);

-- (e) revision is frozen once an asset is ready.
select throws_ok(
  $$ update print_fulfilment_assets set revision = 'r99' where id = 'f0000000-0000-0000-0000-000000000002' $$,
  'asset_immutable',
  'trigger: changing a ready asset revision raises asset_immutable'
);

-- (f) ready → staged is forbidden (would orphan live assignments).
select throws_ok(
  $$ update print_fulfilment_assets set status = 'staged' where id = 'f0000000-0000-0000-0000-000000000002' $$,
  'invalid_status_transition',
  'trigger: ready -> staged raises invalid_status_transition'
);

select * from finish();
rollback;
