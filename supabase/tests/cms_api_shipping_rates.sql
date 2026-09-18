-- pgTAP coverage for the CMS API shipping-rate RPCs: save_shipping_rate_draft,
-- publish_shipping_rate_revision, restore_shipping_rate_draft — plus the
-- one-time backfill 20260917150000_cms_api_shipping_rates.sql performs
-- (revision 1 seeded for BOTH resources from the code constants,
-- published_revision stamped to 1 in the same migration), and the publish-time
-- range check.
-- Run with `supabase test db`.
--
-- NOTE: Docker was unreachable in the environment this file was authored in, so
-- it has NEVER BEEN EXECUTED. Treat a first run as part of verifying the
-- migration, not as a regression check.

begin;
set local search_path to extensions, public, pg_temp;

select plan(37);

-- Backfill ---------------------------------------------------------------------
select is(
  (select count(*)::integer from shipping_rates),
  2,
  'backfill: exactly the two fulfilment-track resources exist'
);

select is(
  (select array_agg(r.id order by r.id) from shipping_rates r),
  array['domestic', 'international'],
  'backfill: the two ids are domestic and international'
);

select is(
  (select count(*)::integer from shipping_rate_drafts),
  2,
  'backfill: exactly one seeded draft per resource'
);

select is(
  (select array_agg(distinct d.revision) from shipping_rate_drafts d),
  array[1],
  'backfill: both seeded drafts are revision 1'
);

select is(
  (select array_agg(r.published_revision order by r.id) from shipping_rates r),
  array[1, 1],
  'backfill: both rows are stamped published at revision 1'
);

select isnt(
  (select r.published_at from shipping_rates r where r.id = 'domestic'),
  null,
  'backfill: published_at is set alongside published_revision'
);

select is(
  (select jsonb_array_length(d.payload->'fields') from shipping_rate_drafts d where d.rate_id = 'domestic'),
  9,
  'backfill: domestic carries 9 fields (3 methods x 3 currencies)'
);

select is(
  (select jsonb_array_length(d.payload->'fields') from shipping_rate_drafts d where d.rate_id = 'international'),
  56,
  'backfill: international carries 56 fields (28 countries x 2 package types)'
);

-- The migration's own DO-block guard already aborts on a mismatch; assert the
-- post-condition explicitly so a future edit that weakens the guard is caught.
select is(
  (select array_agg(t.f->>'key' order by t.ord)
     from shipping_rate_drafts d
     cross join lateral jsonb_array_elements(d.payload->'fields') with ordinality as t(f, ord)
    where d.rate_id = 'domestic'),
  shipping_rate_field_keys('domestic'),
  'backfill: domestic seeds exactly the canonical key list, in order'
);

select is(
  (select array_agg(t.f->>'key' order by t.ord)
     from shipping_rate_drafts d
     cross join lateral jsonb_array_elements(d.payload->'fields') with ordinality as t(f, ord)
    where d.rate_id = 'international'),
  shipping_rate_field_keys('international'),
  'backfill: international seeds exactly the canonical key list, in order'
);

-- Day-one agreement with the code constants (src/lib/pricing.ts,
-- src/lib/print-shipping.ts). The TypeScript side of this same assertion is
-- src/server/cms-api/shipping-rates-mapping.test.ts's migration lockstep.
select is(
  (select shipping_rate_draft_values(d.payload) from shipping_rate_drafts d where d.rate_id = 'domestic'),
  jsonb_build_object(
    'paczkomat_pln', '20', 'kurier_pln', '30', 'odbior_pln', '0',
    'paczkomat_eur', '5',  'kurier_eur', '10', 'odbior_eur', '0',
    'paczkomat_gbp', '5',  'kurier_gbp', '12', 'odbior_gbp', '0'
  ),
  'backfill: domestic values equal SHIPPING_PLN/EUR/GBP exactly'
);

select is(
  (select shipping_rate_draft_values(d.payload)->>'gb_loose_eur' from shipping_rate_drafts d where d.rate_id = 'international'),
  '5.66',
  'backfill: international values are the Prodigi EUR quotes verbatim'
);

select is(
  (select shipping_rate_draft_values(d.payload)->>'cy_framed_eur' from shipping_rate_drafts d where d.rate_id = 'international'),
  '132.43',
  'backfill: two-decimal quotes survive as exact text'
);

-- No second FX-rate source anywhere in either payload (the plan's named hazard).
select is(
  (select count(*)::integer
     from shipping_rate_drafts d
     cross join lateral jsonb_array_elements(d.payload->'fields') as f
    where f->>'key' in ('eur_to_pln', 'eur_to_gbp')),
  0,
  'backfill: neither resource carries an FX rate of its own'
);

-- Audit ------------------------------------------------------------------------
select is(
  (select count(*)::integer from catalog_audit_log where product_id in ('domestic', 'international') and action = 'published'),
  2,
  'backfill: one published audit row per resource, under the resource id sentinel'
);

-- save_shipping_rate_draft -----------------------------------------------------
select is(
  (select d.revision from save_shipping_rate_draft('domestic', 1, '{"fields":[]}'::jsonb, 'anna@studio.pl') d),
  2,
  'save: allocates the next revision for that resource'
);

select is(
  (select count(*)::integer from shipping_rate_drafts where rate_id = 'international'),
  1,
  'save: the other resource is untouched (revisions are per rate_id)'
);

select is(
  (select r.published_revision from shipping_rates r where r.id = 'domestic'),
  1,
  'save: saving a draft never moves published_revision'
);

select throws_ok(
  $$ select save_shipping_rate_draft('domestic', 1, '{"fields":[]}'::jsonb, 'anna@studio.pl') $$,
  'revision_conflict',
  'save: a stale expected revision conflicts'
);

select throws_ok(
  $$ select save_shipping_rate_draft('nope', 0, '{"fields":[]}'::jsonb, 'anna@studio.pl') $$,
  'shipping_rate_not_found',
  'save: an unknown rate id is rejected'
);

select is(
  (select count(*)::integer from catalog_audit_log where product_id = 'domestic' and action = 'draft_saved'),
  1,
  'save: writes a draft_saved audit row'
);

-- publish_shipping_rate_revision ----------------------------------------------
-- Revision 2 above is an empty field list: every canonical key is missing.
select throws_ok(
  $$ select publish_shipping_rate_revision('domestic', 2, 'anna@studio.pl') $$,
  'shipping_rates_invalid',
  'publish: a payload missing the canonical keys is rejected'
);

select is(
  (select r.published_revision from shipping_rates r where r.id = 'domestic'),
  1,
  'publish: a rejected publish leaves published_revision where it was'
);

-- A valid revision 3: copy the seeded revision 1 and bump one value.
select save_shipping_rate_draft(
  'domestic',
  2,
  jsonb_set(
    (select d.payload from shipping_rate_drafts d where d.rate_id = 'domestic' and d.revision = 1),
    '{fields,1,value}',
    '"35"'::jsonb
  ),
  'anna@studio.pl'
);

select is(
  (select (publish_shipping_rate_revision('domestic', 3, 'anna@studio.pl'))->>'ok'),
  'true',
  'publish: a valid revision publishes'
);

select is(
  (select r.published_revision from shipping_rates r where r.id = 'domestic'),
  3,
  'publish: published_revision now names the published draft'
);

select is(
  (select shipping_rate_draft_values(d.payload)->>'kurier_pln'
     from shipping_rate_drafts d
     join shipping_rates r on r.id = d.rate_id and r.published_revision = d.revision
    where d.rate_id = 'domestic'),
  '35',
  'publish: following published_revision yields the new live value'
);

select is(
  (select r.published_revision from shipping_rates r where r.id = 'international'),
  1,
  'publish: the other track is unaffected — the two publish independently'
);

select throws_ok(
  $$ select publish_shipping_rate_revision('domestic', 2, 'anna@studio.pl') $$,
  'revision_conflict',
  'publish: a stale expected revision conflicts'
);

-- Range rules: >= 0 and at most 2 decimal places.
select save_shipping_rate_draft(
  'domestic',
  3,
  jsonb_set(
    (select d.payload from shipping_rate_drafts d where d.rate_id = 'domestic' and d.revision = 1),
    '{fields,1,value}',
    '"-1"'::jsonb
  ),
  'anna@studio.pl'
);

select throws_ok(
  $$ select publish_shipping_rate_revision('domestic', 4, 'anna@studio.pl') $$,
  'shipping_rates_invalid',
  'publish: a negative amount is rejected'
);

select save_shipping_rate_draft(
  'domestic',
  4,
  jsonb_set(
    (select d.payload from shipping_rate_drafts d where d.rate_id = 'domestic' and d.revision = 1),
    '{fields,0,value}',
    '"20.005"'::jsonb
  ),
  'anna@studio.pl'
);

select throws_ok(
  $$ select publish_shipping_rate_revision('domestic', 5, 'anna@studio.pl') $$,
  'shipping_rates_invalid',
  'publish: a third decimal place (silently rounded at charge time) is rejected'
);

-- A trailing-zero literal IS a 2-decimal value and must be accepted — the scale
-- test is `v * 100 = trunc(v * 100)`, not scale(v) <= 2.
select save_shipping_rate_draft(
  'domestic',
  5,
  jsonb_set(
    (select d.payload from shipping_rate_drafts d where d.rate_id = 'domestic' and d.revision = 1),
    '{fields,0,value}',
    '"20.500"'::jsonb
  ),
  'anna@studio.pl'
);

select is(
  (select (publish_shipping_rate_revision('domestic', 6, 'anna@studio.pl'))->>'ok'),
  'true',
  'publish: 20.500 is accepted — trailing zeros carry no scale'
);

select throws_ok(
  $$ select publish_shipping_rate_revision('international', 0, 'anna@studio.pl') $$,
  'revision_conflict',
  'publish: revision 0 conflicts before it can hit the composite FK'
);

-- restore_shipping_rate_draft --------------------------------------------------
select is(
  (select d.revision from restore_shipping_rate_draft('domestic', 6, 1, 'anna@studio.pl') d),
  7,
  'restore: re-saves the source payload as a brand-new revision'
);

select is(
  (select r.published_revision from shipping_rates r where r.id = 'domestic'),
  6,
  'restore: NEVER moves published_revision — restoring is not publishing'
);

select is(
  (select shipping_rate_draft_values(d.payload)->>'kurier_pln'
     from shipping_rate_drafts d where d.rate_id = 'domestic' and d.revision = 7),
  '30',
  'restore: the new revision carries the source revision values'
);

select throws_ok(
  $$ select restore_shipping_rate_draft('domestic', 7, 99, 'anna@studio.pl') $$,
  'source_revision_not_found',
  'restore: an unknown source revision is rejected'
);

-- Immutability: nothing is ever deleted or rewritten.
select is(
  (select count(*)::integer from shipping_rate_drafts where rate_id = 'domestic'),
  7,
  'every revision ever saved is still present'
);

select * from finish();
rollback;
