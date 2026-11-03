-- pgTAP coverage for the CMS API pricing RPCs: save_pricing_draft,
-- publish_pricing_revision, restore_pricing_draft — plus the one-time backfill
-- 20260917140000_cms_api_pricing.sql performs (revision 1 seeded from the live
-- print_pricing_config row, published_revision stamped to 1 in the same
-- migration), and the publish-time range check that re-encodes that table's own
-- CHECK constraints.
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
  (select count(*)::integer from pricing_config_drafts),
  1,
  'backfill: exactly one draft revision exists after the migration'
);

select is(
  (select d.revision from pricing_config_drafts d),
  1,
  'backfill: the seeded draft is revision 1'
);

select is(
  (select c.published_revision from print_pricing_config c),
  1,
  'backfill: the live row is stamped published at revision 1'
);

select is(
  (select jsonb_array_length(d.payload->'fields') from pricing_config_drafts d where d.revision = 1),
  11,
  'backfill: revision 1 carries all 11 fields'
);

-- Day-one agreement: every seeded field value must equal the live column it
-- came from, or the CMS would show numbers checkout is not charging.
select is(
  (select pricing_config_draft_values(d.payload) from pricing_config_drafts d where d.revision = 1),
  (select jsonb_build_object(
     'base_30x40_eur',   c.base_30x40_eur::text,
     'base_50x70_eur',   c.base_50x70_eur::text,
     'base_70x100_eur',  c.base_70x100_eur::text,
     'frame_30x40_eur',  c.frame_30x40_eur::text,
     'frame_50x70_eur',  c.frame_50x70_eur::text,
     'frame_70x100_eur', c.frame_70x100_eur::text,
     'mount_30x40_eur',  c.mount_30x40_eur::text,
     'mount_50x70_eur',  c.mount_50x70_eur::text,
     'mount_70x100_eur', c.mount_70x100_eur::text,
     'eur_to_pln',       rtrim(rtrim(c.eur_to_pln::text, '0'), '.'),
     'eur_to_gbp',       rtrim(rtrim(c.eur_to_gbp::text, '0'), '.')
   ) from print_pricing_config c),
  'backfill: revision 1 values equal the live print_pricing_config row exactly'
);

select is(
  (select cal.action from catalog_audit_log cal where cal.product_id = 'print-pricing' order by cal.created_at desc limit 1),
  'published',
  'backfill: writes a published audit row under the print-pricing sentinel'
);

-- pricing_config_draft_values --------------------------------------------------
select is(
  pricing_config_draft_values('{"fields":[]}'::jsonb),
  '{}'::jsonb,
  'pricing_config_draft_values: an empty fields array yields an empty object, not null'
);

select is(
  pricing_config_draft_values('{}'::jsonb),
  '{}'::jsonb,
  'pricing_config_draft_values: an absent fields key yields an empty object, not null'
);

select is(
  pricing_config_draft_values('{"fields":[{"key":"eur_to_pln","value":"4.25"},{"key":"eur_to_pln","value":"4.50"}]}'::jsonb),
  '{"eur_to_pln":"4.50"}'::jsonb,
  'pricing_config_draft_values: duplicate keys resolve to the last occurrence'
);

-- A reusable, fully-valid payload built from the current live row.
create temporary table tap_pricing_fixture as
select (select d.payload from pricing_config_drafts d where d.revision = 1) as valid_payload;

-- save_pricing_draft ------------------------------------------------------------
select is(
  (save_pricing_draft(1, (select valid_payload from tap_pricing_fixture), 'anna@studio.pl')).revision,
  2,
  'save_pricing_draft: increments revision'
);

select throws_ok(
  $$ select save_pricing_draft(1, '{"fields":[]}'::jsonb, 'anna@studio.pl') $$,
  'revision_conflict',
  'save_pricing_draft: stale expectedRevision is rejected'
);

select is(
  (select c.published_revision from print_pricing_config c),
  1,
  'save_pricing_draft: saving a draft does not publish it'
);

-- Saving an out-of-range draft is deliberately allowed (the operator is
-- mid-edit); only publishing enforces ranges.
select is(
  (save_pricing_draft(2, '{"fields":[{"key":"base_30x40_eur","value":"-5"}]}'::jsonb, 'anna@studio.pl')).revision,
  3,
  'save_pricing_draft: an out-of-range draft may be saved'
);

select is(
  (select cal.action from catalog_audit_log cal where cal.product_id = 'print-pricing' order by cal.created_at desc limit 1),
  'draft_saved',
  'save_pricing_draft: writes a draft_saved audit row'
);

-- publish_pricing_revision ------------------------------------------------------
select throws_ok(
  $$ select publish_pricing_revision(3, 'anna@studio.pl') $$,
  'pricing_invalid',
  'publish_pricing_revision: an out-of-range draft is rejected, not written'
);

select is(
  (select c.published_revision from print_pricing_config c),
  1,
  'publish_pricing_revision: a rejected publish leaves published_revision alone'
);

select throws_ok(
  $$ select publish_pricing_revision(2, 'anna@studio.pl') $$,
  'revision_conflict',
  'publish_pricing_revision: publishing a non-current revision is rejected'
);

-- Each boundary case below re-saves a fresh draft, then attempts to publish it.
create or replace function tap_publish_with(p_key text, p_value text) returns void
language plpgsql as $$
declare
  v_payload jsonb;
  v_rev     integer;
begin
  select (select valid_payload from tap_pricing_fixture) into v_payload;
  v_payload := jsonb_set(
    v_payload,
    '{fields}',
    (select jsonb_agg(case when f->>'key' = p_key then jsonb_set(f, '{value}', to_jsonb(p_value)) else f end)
       from jsonb_array_elements(v_payload->'fields') as f)
  );
  select coalesce(max(d.revision), 0) into v_rev from pricing_config_drafts d;
  perform save_pricing_draft(v_rev, v_payload, 'anna@studio.pl');
  perform publish_pricing_revision(v_rev + 1, 'anna@studio.pl');
end;
$$;

select throws_ok(
  $$ select tap_publish_with('base_30x40_eur', '0') $$,
  'pricing_invalid',
  'publish: base_*_eur = 0 is rejected (DB check is "> 0")'
);

select lives_ok(
  $$ select tap_publish_with('base_30x40_eur', '1') $$,
  'publish: base_*_eur = 1 is accepted (smallest value satisfying "> 0")'
);

select lives_ok(
  $$ select tap_publish_with('frame_30x40_eur', '0') $$,
  'publish: frame_*_eur = 0 is accepted (DB check is ">= 0")'
);

select throws_ok(
  $$ select tap_publish_with('frame_30x40_eur', '-1') $$,
  'pricing_invalid',
  'publish: frame_*_eur = -1 is rejected'
);

select lives_ok(
  $$ select tap_publish_with('mount_70x100_eur', '0') $$,
  'publish: mount_*_eur = 0 is accepted'
);

select throws_ok(
  $$ select tap_publish_with('base_50x70_eur', '25.5') $$,
  'pricing_invalid',
  'publish: a fractional EUR value is rejected (the column is integer)'
);

select throws_ok(
  $$ select tap_publish_with('eur_to_pln', '0') $$,
  'pricing_invalid',
  'publish: eur_to_pln = 0 is rejected (DB check is "> 0")'
);

select lives_ok(
  $$ select tap_publish_with('eur_to_pln', '100') $$,
  'publish: eur_to_pln = 100 is accepted ("<= 100" is inclusive)'
);

select throws_ok(
  $$ select tap_publish_with('eur_to_pln', '100.0001') $$,
  'pricing_invalid',
  'publish: eur_to_pln just past 100 is rejected'
);

select throws_ok(
  $$ select tap_publish_with('eur_to_gbp', '0.86005') $$,
  'pricing_invalid',
  'publish: a 5-decimal rate numeric(8,4) would silently round is rejected'
);

-- Trailing zeros are not precision: '0.86000' IS 0.86. The scale test is
-- "v x 10000 is whole", not scale(), which would count the literal's zeros and
-- diverge from the TS validator.
select lives_ok(
  $$ select tap_publish_with('eur_to_gbp', '0.86000') $$,
  'publish: a rate padded past 4 decimals with zeros is accepted'
);

select throws_ok(
  $$ select tap_publish_with('eur_to_gbp', '') $$,
  'pricing_invalid',
  'publish: a blank value is rejected'
);

-- A successful publish must move the live row's own columns, not just the
-- published_revision pointer.
select lives_ok(
  $$ select tap_publish_with('base_70x100_eur', '81') $$,
  'publish: a valid draft publishes'
);

select is(
  (select c.base_70x100_eur from print_pricing_config c),
  81,
  'publish: the live singleton row now carries the published value'
);

select is(
  (select c.published_revision from print_pricing_config c),
  (select max(d.revision) from pricing_config_drafts d),
  'publish: published_revision points at the just-published draft'
);

-- restore_pricing_draft ---------------------------------------------------------
select is(
  (restore_pricing_draft((select max(d.revision) from pricing_config_drafts d), 1, 'anna@studio.pl')).payload,
  (select d.payload from pricing_config_drafts d where d.revision = 1),
  'restore_pricing_draft: the new revision carries the source revision payload'
);

select is(
  (select c.base_70x100_eur from print_pricing_config c),
  81,
  'restore_pricing_draft: restoring does NOT touch the live row — checkout is unaffected'
);

select throws_ok(
  $$ select restore_pricing_draft((select max(d.revision)::integer from pricing_config_drafts d), 999, 'anna@studio.pl') $$,
  'source_revision_not_found',
  'restore_pricing_draft: an unknown source revision is rejected'
);

-- Grants ------------------------------------------------------------------------
select ok(
  not has_function_privilege('anon', 'publish_pricing_revision(integer,text)', 'execute'),
  'publish_pricing_revision: anon cannot execute'
);

select ok(
  has_function_privilege('service_role', 'publish_pricing_revision(integer,text)', 'execute'),
  'publish_pricing_revision: service_role can execute'
);

select * from finish();
rollback;
