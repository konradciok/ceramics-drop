-- CMS API — print-pricing drafts, publish/restore RPCs.
-- -----------------------------------------------------------------------------
-- Additive resource type structurally mirroring
-- supabase/migrations/20260915120000_cms_api_collections.sql's collection_drafts /
-- collections.published_revision / save_collection_draft /
-- publish_collection_revision / restore_collection_draft set, minus the
-- collection_id parameter: pricing is a TRUE SINGLETON. There is exactly one
-- pricing resource, exposed by the CmsApi under the fixed, well-known id
-- 'print-pricing' (which is also the sentinel catalog_audit_log.product_id the
-- pre-existing legacy writer — src/lib/print-pricing-config/repository.ts's
-- updatePrintPricingConfig — already uses, so pricing's audit history stays
-- continuous across old and new writers with no audit-schema change).
--
-- print_pricing_config (20260807120000_print_pricing_config.sql) STAYS
-- CANONICAL. Checkout and the storefront read that single row directly via
-- src/lib/print-pricing-config/{load,get}.ts + the pure calculator in
-- src/lib/print-pricing.ts; this migration never touches that read path. All it
-- does is put a versioned draft/publish WRITE path in front of the row:
-- publish_pricing_revision promotes one draft revision into the live row.
--
-- Same RLS posture as every sibling table: enabled, no policies (service-role
-- only, via the CmsApi Worker's service-role key).

-- 1. pricing_config_drafts ────────────────────────────────────────────────────
-- One immutable row per saved draft, exactly like collection_drafts, except
-- `revision` alone is unique (no resource_id to compose with — singleton).
-- revision starts at 1 and only ever increments; nothing is ever deleted or
-- rewritten (docs/cms-api-data-model.md).
--
-- payload is {fields: Field[]} — no `name` key, unlike collection_drafts'
-- {name, fields}: the pricing resource's display name is a fixed constant
-- owned by src/server/cms-api/pricing-mapping.ts (PRICING_RESOURCE_NAME), not
-- a client-editable, persisted value (same posture as content's fixed
-- EditableContentDocument.label — see src/server/cms-api/handlers/content-save.ts).
--
-- The unique constraint on `revision` creates the btree index that
-- `order by revision desc limit 1` (pricing-mapping.ts's latest-draft read)
-- uses, so no separate index is created here.
create table pricing_config_drafts (
  id         uuid primary key default gen_random_uuid(),
  revision   integer not null unique,
  payload    jsonb not null,
  created_by text,
  created_at timestamptz not null default now()
);

alter table pricing_config_drafts enable row level security;

-- 2. print_pricing_config.published_revision ──────────────────────────────────
-- Nullable, and left null for exactly as long as step 4's backfill takes to
-- run in this same transaction. References pricing_config_drafts(revision)
-- (a plain, not composite, FK — singleton).
alter table print_pricing_config add column published_revision integer
  references pricing_config_drafts(revision);

-- 3. pricing_config_draft_values ──────────────────────────────────────────────
-- Shared, immutable key->value extraction used by publish_pricing_revision
-- below AND by the one-time backfill in step 4, so "how a Field[] payload
-- becomes the 11 named values" is written once. Duplicate keys resolve to the
-- last occurrence (jsonb_object_agg semantics); an empty/absent fields array
-- yields '{}'::jsonb rather than null.
create or replace function pricing_config_draft_values(p_payload jsonb)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(
    (select jsonb_object_agg(f->>'key', f->>'value')
       from jsonb_array_elements(coalesce(p_payload->'fields', '[]'::jsonb)) as f
      where f->>'key' is not null),
    '{}'::jsonb
  );
$$;

revoke all on function pricing_config_draft_values(jsonb) from public, anon, authenticated;
grant execute on function pricing_config_draft_values(jsonb) to service_role;

-- 4. One-time backfill: revision 1 == the CURRENT LIVE ROW ────────────────────
-- Day one, the new system must agree with checkout's live read path exactly:
-- seed pricing_config_drafts revision 1 from print_pricing_config's current
-- values and stamp published_revision = 1 in this same migration (and
-- therefore the same transaction), so there is never a window where the live
-- row has no corresponding published draft.
--
-- The 11 field keys below are the print_pricing_config COLUMN NAMES verbatim.
-- That is deliberate: publish_pricing_revision writes exactly these columns, so
-- key == column means the plpgsql parser needs no translation table and a
-- fieldErrors key names the exact column whose CHECK constraint would have
-- fired. Keys AND labels are kept in lockstep with
-- src/server/cms-api/pricing-mapping.ts's PRICING_FIELD_DEFS by
-- src/server/cms-api/pricing-mapping.test.ts, which parses THIS statement — so
-- editing one side without the other fails CI rather than silently drifting
-- (same guard style as src/lib/print-pricing-config/migration-lockstep.test.ts).
--
-- EUR columns are `integer` (MAJOR units, whole euro), so ::text is exact.
-- eur_to_pln/eur_to_gbp are numeric(8,4), whose ::text always carries all four
-- decimals ('4.2500'); the rtrim pair trims the trailing zeros (and then a
-- bare trailing '.') so the seeded Field value reads '4.25', not '4.2500'.
-- Trimming trailing zeros never changes the numeric value, so the round trip
-- back into numeric(8,4) at publish time is exact.
insert into pricing_config_drafts (revision, payload, created_by)
select
  1,
  jsonb_build_object('fields', jsonb_build_array(
    jsonb_build_object('key', 'base_30x40_eur',   'label', 'Cena bazowa 30 × 40 cm (EUR)',            'type', 'number', 'value', c.base_30x40_eur::text,   'locale', 'none', 'sourceLocale', 'none'),
    jsonb_build_object('key', 'base_50x70_eur',   'label', 'Cena bazowa 50 × 70 cm (EUR)',            'type', 'number', 'value', c.base_50x70_eur::text,   'locale', 'none', 'sourceLocale', 'none'),
    jsonb_build_object('key', 'base_70x100_eur',  'label', 'Cena bazowa 70 × 100 cm (EUR)',           'type', 'number', 'value', c.base_70x100_eur::text,  'locale', 'none', 'sourceLocale', 'none'),
    jsonb_build_object('key', 'frame_30x40_eur',  'label', 'Dopłata za ramę 30 × 40 cm (EUR)',        'type', 'number', 'value', c.frame_30x40_eur::text,  'locale', 'none', 'sourceLocale', 'none'),
    jsonb_build_object('key', 'frame_50x70_eur',  'label', 'Dopłata za ramę 50 × 70 cm (EUR)',        'type', 'number', 'value', c.frame_50x70_eur::text,  'locale', 'none', 'sourceLocale', 'none'),
    jsonb_build_object('key', 'frame_70x100_eur', 'label', 'Dopłata za ramę 70 × 100 cm (EUR)',       'type', 'number', 'value', c.frame_70x100_eur::text, 'locale', 'none', 'sourceLocale', 'none'),
    jsonb_build_object('key', 'mount_30x40_eur',  'label', 'Dopłata za passe-partout 30 × 40 cm (EUR)',  'type', 'number', 'value', c.mount_30x40_eur::text,  'locale', 'none', 'sourceLocale', 'none'),
    jsonb_build_object('key', 'mount_50x70_eur',  'label', 'Dopłata za passe-partout 50 × 70 cm (EUR)',  'type', 'number', 'value', c.mount_50x70_eur::text,  'locale', 'none', 'sourceLocale', 'none'),
    jsonb_build_object('key', 'mount_70x100_eur', 'label', 'Dopłata za passe-partout 70 × 100 cm (EUR)', 'type', 'number', 'value', c.mount_70x100_eur::text, 'locale', 'none', 'sourceLocale', 'none'),
    jsonb_build_object('key', 'eur_to_pln',       'label', 'Kurs EUR → PLN (wynik zaokrąglany do 5 zł)', 'type', 'number', 'value', rtrim(rtrim(c.eur_to_pln::text, '0'), '.'), 'locale', 'none', 'sourceLocale', 'none'),
    jsonb_build_object('key', 'eur_to_gbp',       'label', 'Kurs EUR → GBP (wynik zaokrąglany do 1 £)', 'type', 'number', 'value', rtrim(rtrim(c.eur_to_gbp::text, '0'), '.'), 'locale', 'none', 'sourceLocale', 'none')
  )),
  'migration:20260917140000_cms_api_pricing'
from print_pricing_config c
where c.id;

-- Stamp the live row as published at revision 1. Guarded by the same
-- `where c.id` so it is a no-op (rather than an error) on the pathological
-- case of an absent singleton row, in which case the insert above seeded
-- nothing either and the two stay consistent.
update print_pricing_config c set published_revision = 1 where c.id;

-- Audit the backfill under the same sentinel product_id the legacy writer
-- already uses, so the CMS's GET /v1/audit?resourceId=print-pricing history
-- shows an unbroken line from the legacy 'pricing:update' rows through this
-- cutover into the new RPCs' rows. collection_id stays null, satisfying
-- catalog_audit_log_product_or_collection_check (num_nonnulls = 1).
insert into catalog_audit_log (product_id, actor_email, action, before, after, revision)
select 'print-pricing', null, 'published', null, to_jsonb(c), 1
from print_pricing_config c
where c.id;

-- 5. save_pricing_draft ───────────────────────────────────────────────────────
-- Mirrors save_collection_draft. The `for update` row lock is taken on
-- print_pricing_config's singleton row — the same row publish_pricing_revision
-- locks — so draft-revision allocation is serialized against every other
-- pricing write. pricing_config_drafts.revision's unique constraint is the
-- backstop if that lock is ever bypassed.
--
-- No range checking happens here: a draft may hold any values at all (the
-- operator is mid-edit). Ranges are enforced at PUBLISH time only — see
-- publish_pricing_revision.
create or replace function save_pricing_draft(
  p_expected_revision integer,
  p_payload           jsonb,
  p_actor_email       text
) returns pricing_config_drafts
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_current_revision integer;
  v_new_revision     integer;
  v_row              pricing_config_drafts%rowtype;
  v_previous         jsonb;
begin
  perform 1 from print_pricing_config c where c.id for update;
  if not found then
    raise 'pricing_config_missing';
  end if;

  select coalesce(max(d.revision), 0) into v_current_revision from pricing_config_drafts d;

  if v_current_revision <> p_expected_revision then
    raise 'revision_conflict' using detail = format('currentRevision=%s', v_current_revision);
  end if;

  select d.payload into v_previous from pricing_config_drafts d order by d.revision desc limit 1;

  v_new_revision := v_current_revision + 1;

  insert into pricing_config_drafts (revision, payload, created_by)
  values (v_new_revision, p_payload, p_actor_email)
  returning * into v_row;

  insert into catalog_audit_log (product_id, actor_email, action, before, after, revision)
  values ('print-pricing', p_actor_email, 'draft_saved', v_previous, p_payload, v_new_revision);

  return v_row;
end;
$$;

revoke all on function save_pricing_draft(integer, jsonb, text) from public, anon, authenticated;
grant execute on function save_pricing_draft(integer, jsonb, text) to service_role;

-- 6. publish_pricing_revision ─────────────────────────────────────────────────
-- The only place the live print_pricing_config row is written by the CmsApi.
--
-- Transaction / locking discipline (modelled on publish_collection_revision):
-- the singleton row is SELECT ... FOR UPDATE'd as the FIRST statement, before
-- the revision check, before parsing, before validation. Everything that
-- follows — read the draft, validate, UPDATE the live row, write the audit row
-- — happens inside that one lock and one transaction (a plpgsql function
-- invoked as an RPC is a single statement, hence a single transaction). So a
-- concurrent publish blocks rather than interleaving, and checkout — which
-- reads this one row with a plain, uncontended SELECT — sees either the whole
-- old row or the whole new row, never a torn mixture. There is no window in
-- which published_revision points at a revision whose values are not in the
-- row's own columns.
--
-- Range validation re-encodes print_pricing_config's own CHECK constraints
-- (20260807120000_print_pricing_config.sql) verbatim:
--     base_*_eur   integer  check (> 0)
--     frame_*_eur  integer  check (>= 0)
--     mount_*_eur  integer  check (>= 0)
--     eur_to_pln   numeric(8,4) check (> 0 and <= 100)
--     eur_to_gbp   numeric(8,4) check (> 0 and <= 100)
-- plus the scale limit the numeric(8,4) column type would otherwise apply by
-- SILENTLY ROUNDING (4.25005 -> 4.2501) rather than rejecting — mirroring
-- src/lib/print-pricing-config/schema.ts's `rate` refine. Every rule here is a
-- property of the print_pricing_config table itself; nothing app-level is
-- duplicated. The point of re-checking at all is to fail with a named,
-- parseable error (pricing_invalid, detail invalidKeys=<comma-joined keys>,
-- same detail-string convention as publish_collection_revision's
-- product_ref_invalid / invalidIds=) instead of an opaque 23514 constraint
-- violation. The constraints themselves remain the actual enforcement.
create or replace function publish_pricing_revision(
  p_expected_revision integer,
  p_actor_email       text
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_current_revision integer;
  v_config           print_pricing_config%rowtype;
  v_payload          jsonb;
  v_values           jsonb;
  v_before           jsonb;
  v_after            jsonb;
  v_key              text;
  v_text             text;
  v_num              numeric;
  v_invalid          text[] := array[]::text[];
  v_eur_keys         text[] := array[
    'base_30x40_eur', 'base_50x70_eur', 'base_70x100_eur',
    'frame_30x40_eur', 'frame_50x70_eur', 'frame_70x100_eur',
    'mount_30x40_eur', 'mount_50x70_eur', 'mount_70x100_eur'
  ];
  v_rate_keys        text[] := array['eur_to_pln', 'eur_to_gbp'];
begin
  select * into v_config from print_pricing_config c where c.id for update;
  if not found then
    raise 'pricing_config_missing';
  end if;

  select coalesce(max(d.revision), 0) into v_current_revision from pricing_config_drafts d;

  if v_current_revision <> p_expected_revision then
    raise 'revision_conflict' using detail = format('currentRevision=%s', v_current_revision);
  end if;

  -- revision 0 means "no draft has ever been saved" (pricing_config_drafts.revision
  -- starts at 1). The migration's backfill makes this unreachable in practice;
  -- kept so publishing at 0 is a clear 4xx rather than an unmapped FK violation,
  -- exactly as in publish_collection_revision.
  if p_expected_revision = 0 then
    raise 'draft_required';
  end if;

  select d.payload into v_payload from pricing_config_drafts d where d.revision = p_expected_revision;
  if v_payload is null then
    raise 'draft_required';
  end if;

  v_values := pricing_config_draft_values(v_payload);

  -- 9 EUR integers.
  foreach v_key in array v_eur_keys loop
    v_text := btrim(coalesce(v_values->>v_key, ''));
    if v_text !~ '^-?[0-9]+$' then
      -- absent, blank, fractional, or otherwise not an integer literal: the
      -- column is `integer`, so anything else would be a cast failure.
      v_invalid := array_append(v_invalid, v_key);
    else
      v_num := v_text::numeric;
      -- base_*_eur checks (> 0); frame_*_eur / mount_*_eur check (>= 0).
      if left(v_key, 5) = 'base_' then
        if v_num <= 0 then v_invalid := array_append(v_invalid, v_key); end if;
      else
        if v_num < 0 then v_invalid := array_append(v_invalid, v_key); end if;
      end if;
    end if;
  end loop;

  -- 2 FX rates.
  foreach v_key in array v_rate_keys loop
    v_text := btrim(coalesce(v_values->>v_key, ''));
    if v_text !~ '^-?[0-9]+(\.[0-9]+)?$' then
      v_invalid := array_append(v_invalid, v_key);
    else
      v_num := v_text::numeric;
      if v_num <= 0 or v_num > 100 or scale(v_num) > 4 then
        v_invalid := array_append(v_invalid, v_key);
      end if;
    end if;
  end loop;

  if array_length(v_invalid, 1) is not null then
    raise exception 'pricing_invalid' using detail = format('invalidKeys=%s', array_to_string(v_invalid, ','));
  end if;

  v_before := to_jsonb(v_config);

  update print_pricing_config c set
    base_30x40_eur     = (v_values->>'base_30x40_eur')::integer,
    base_50x70_eur     = (v_values->>'base_50x70_eur')::integer,
    base_70x100_eur    = (v_values->>'base_70x100_eur')::integer,
    frame_30x40_eur    = (v_values->>'frame_30x40_eur')::integer,
    frame_50x70_eur    = (v_values->>'frame_50x70_eur')::integer,
    frame_70x100_eur   = (v_values->>'frame_70x100_eur')::integer,
    mount_30x40_eur    = (v_values->>'mount_30x40_eur')::integer,
    mount_50x70_eur    = (v_values->>'mount_50x70_eur')::integer,
    mount_70x100_eur   = (v_values->>'mount_70x100_eur')::integer,
    eur_to_pln         = (v_values->>'eur_to_pln')::numeric,
    eur_to_gbp         = (v_values->>'eur_to_gbp')::numeric,
    published_revision = p_expected_revision,
    updated_at         = now(),
    updated_by         = p_actor_email
  where c.id;

  select * into v_config from print_pricing_config c where c.id;
  v_after := to_jsonb(v_config);

  insert into catalog_audit_log (product_id, actor_email, action, before, after, revision)
  values ('print-pricing', p_actor_email, 'published', v_before, v_after, p_expected_revision);

  return jsonb_build_object('ok', true, 'pricing', v_after);
end;
$$;

revoke all on function publish_pricing_revision(integer, text) from public, anon, authenticated;
grant execute on function publish_pricing_revision(integer, text) to service_role;

-- 7. restore_pricing_draft ────────────────────────────────────────────────────
-- Mirrors restore_collection_draft: re-saves an old revision's payload as a
-- brand-new revision (current max + 1). Nothing is deleted or rewritten, and
-- print_pricing_config is NEVER touched — restoring an old draft does not
-- publish it, so the live row (and therefore checkout) is unaffected until an
-- explicit publish_pricing_revision call.
create or replace function restore_pricing_draft(
  p_expected_revision integer,
  p_source_revision   integer,
  p_actor_email       text
) returns pricing_config_drafts
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_current_revision integer;
  v_new_revision     integer;
  v_source_payload   jsonb;
  v_previous         jsonb;
  v_row              pricing_config_drafts%rowtype;
begin
  perform 1 from print_pricing_config c where c.id for update;
  if not found then
    raise 'pricing_config_missing';
  end if;

  select coalesce(max(d.revision), 0) into v_current_revision from pricing_config_drafts d;

  if v_current_revision <> p_expected_revision then
    raise 'revision_conflict' using detail = format('currentRevision=%s', v_current_revision);
  end if;

  select d.payload into v_source_payload from pricing_config_drafts d where d.revision = p_source_revision;
  if v_source_payload is null then
    raise 'source_revision_not_found';
  end if;

  select d.payload into v_previous from pricing_config_drafts d order by d.revision desc limit 1;

  v_new_revision := v_current_revision + 1;

  insert into pricing_config_drafts (revision, payload, created_by)
  values (v_new_revision, v_source_payload, p_actor_email)
  returning * into v_row;

  insert into catalog_audit_log (product_id, actor_email, action, before, after, revision)
  values ('print-pricing', p_actor_email, 'restored', v_previous, v_source_payload, v_new_revision);

  return v_row;
end;
$$;

revoke all on function restore_pricing_draft(integer, integer, text) from public, anon, authenticated;
grant execute on function restore_pricing_draft(integer, integer, text) to service_role;

-- ============================================================
-- Rollback (manual):
--   drop function if exists restore_pricing_draft(integer, integer, text);
--   drop function if exists publish_pricing_revision(integer, text);
--   drop function if exists save_pricing_draft(integer, jsonb, text);
--   drop function if exists pricing_config_draft_values(jsonb);
--   delete from catalog_audit_log
--     where product_id = 'print-pricing'
--       and action in ('draft_saved', 'published', 'restored');
--   alter table print_pricing_config drop column if exists published_revision;
--   drop table if exists pricing_config_drafts;
-- ============================================================
