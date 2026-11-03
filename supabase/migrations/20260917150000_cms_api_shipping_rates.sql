-- CMS API — shipping-rate drafts, publish/restore RPCs.
-- -----------------------------------------------------------------------------
-- Additive resource type structurally mirroring
-- supabase/migrations/20260915120000_cms_api_collections.sql's collection_drafts /
-- collections.published_revision / save_collection_draft /
-- publish_collection_revision / restore_collection_draft set (the rate_id
-- parameter plays collection_id's role), refined with the conventions
-- 20260917140000_cms_api_pricing.sql settled on: a shared immutable
-- key->value extractor used by both the backfill and publish, exact-numeric
-- (not scale()) precision checks, and an invalidKeys= detail string.
--
-- TWO resources, one per fulfilment track — not a singleton like pricing, and
-- not an open-ended list like collections:
--   'domestic'      — 9 values, 3 InPost delivery methods x 3 currencies
--                     (src/lib/pricing.ts's SHIPPING_PLN/EUR/GBP)
--   'international' — 56 values, 28 Prodigi destinations x {framed, loose},
--                     EUR only (src/lib/print-shipping.ts's SHIPPING_EUR)
-- A cart is never mixed between the two tracks, and the two price lists have
-- always been maintained as separate modules, so they publish independently.
--
-- FX-RATE OWNERSHIP — read before adding any column here. International
-- shipping converts EUR to PLN/GBP using print_pricing_config's
-- eur_to_pln/eur_to_gbp (post-20260917140000: whatever the pricing
-- draft/publish system has published into that row), the SAME rates the item
-- prices are derived with. This schema deliberately carries NO rate of its
-- own — not a column, not a cached copy, not a snapshot in a draft payload.
-- Two independent sources for one currency pair would let an order's item
-- prices and its shipping drift apart silently, which is exactly the bug the
-- shared source exists to prevent.
--
-- Unlike pricing, publishing here writes NO value columns anywhere: there is
-- no live shipping-rate table to update, so publish_shipping_rate_revision
-- validates the payload and stamps shipping_rates.published_revision, exactly
-- like publish_collection_revision. The published draft's payload IS the live
-- value — src/lib/shipping-rates/load.ts reads it back by that pointer.
--
-- Same RLS posture as every sibling table: enabled, no policies (service-role
-- only, via the CmsApi Worker's service-role key).

-- 1. shipping_rates ───────────────────────────────────────────────────────────
-- published_revision is added in step 3 once shipping_rate_drafts exists —
-- the same circular-FK resolution collections used inside one file.
create table shipping_rates (
  id           text primary key,                      -- 'domestic' | 'international'
  published_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table shipping_rates enable row level security;

-- 2. shipping_rate_drafts ─────────────────────────────────────────────────────
-- One immutable row per saved draft, exactly like collection_drafts:
-- (rate_id, revision) is unique, revision starts at 1 and only ever increments;
-- nothing is ever deleted or rewritten (docs/cms-api-data-model.md). payload is
-- {fields: Field[]} — no `name` key (like pricing_config_drafts, and unlike
-- collection_drafts): each resource's display name is a fixed constant owned by
-- src/server/cms-api/shipping-rates-mapping.ts (SHIPPING_RATE_NAMES), not a
-- client-editable persisted value.
create table shipping_rate_drafts (
  id         uuid primary key default gen_random_uuid(),
  rate_id    text not null references shipping_rates(id) on delete cascade,
  revision   integer not null,
  payload    jsonb not null,
  created_by text,
  created_at timestamptz not null default now(),
  unique (rate_id, revision)
);

alter table shipping_rate_drafts enable row level security;

create index shipping_rate_drafts_rate_idx on shipping_rate_drafts (rate_id, revision desc);

-- 3. shipping_rates.published_revision ────────────────────────────────────────
-- Nullable, and left null for exactly as long as step 6's backfill takes to run
-- in this same transaction.
alter table shipping_rates add column published_revision integer;

alter table shipping_rates
  add constraint shipping_rates_published_revision_fk
  foreign key (id, published_revision) references shipping_rate_drafts (rate_id, revision);

-- 4. shipping_rate_field_keys ─────────────────────────────────────────────────
-- The canonical key list per resource — the single plpgsql-side statement of
-- "which fields must a publishable payload carry". publish_shipping_rate_revision
-- below range-checks exactly these, and step 6's backfill asserts the payload it
-- just seeded carries exactly these, in this order, so the two can never drift
-- apart unnoticed inside the database.
--
-- Keys are lower snake_case with an explicit currency suffix, mirroring
-- pricing's base_30x40_eur style. They are kept in lockstep with
-- src/server/cms-api/shipping-rates-mapping.ts's DOMESTIC_FIELD_DEFS /
-- INTERNATIONAL_FIELD_DEFS by shipping-rates-mapping.test.ts, which parses THIS
-- file — so editing one side without the other fails CI rather than silently
-- drifting (same guard style as src/lib/print-pricing-config/migration-lockstep.test.ts).
--
-- The 28 country codes are src/lib/print-shipping.ts's PRINT_COUNTRIES verbatim,
-- in that same order (EU members + UK).
create or replace function shipping_rate_field_keys(p_rate_id text)
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_rate_id
    when 'domestic' then array[
      'paczkomat_pln', 'kurier_pln', 'odbior_pln',
      'paczkomat_eur', 'kurier_eur', 'odbior_eur',
      'paczkomat_gbp', 'kurier_gbp', 'odbior_gbp'
    ]
    when 'international' then (
      select array_agg(lower(c.code) || '_' || p.pack || '_eur' order by c.ord, p.ord)
        from unnest(array[
          'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR',
          'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL',
          'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'GB'
        ]) with ordinality as c(code, ord)
        cross join (values ('framed', 1), ('loose', 2)) as p(pack, ord)
    )
  end;
$$;

revoke all on function shipping_rate_field_keys(text) from public, anon, authenticated;
grant execute on function shipping_rate_field_keys(text) to service_role;

-- 5. shipping_rate_draft_values ───────────────────────────────────────────────
-- Shared, immutable key->value extraction used by publish_shipping_rate_revision
-- below AND by the backfill assertion in step 6, so "how a Field[] payload
-- becomes named values" is written once. Duplicate keys resolve to the last
-- occurrence (jsonb_object_agg semantics — matched exactly by
-- shipping-rates-mapping.ts's shippingRateFieldValues); an empty/absent fields
-- array yields '{}'::jsonb rather than null. Structurally identical to
-- pricing_config_draft_values.
create or replace function shipping_rate_draft_values(p_payload jsonb)
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

revoke all on function shipping_rate_draft_values(jsonb) from public, anon, authenticated;
grant execute on function shipping_rate_draft_values(jsonb) to service_role;

-- 6. One-time backfill: revision 1 == THE CURRENT CODE CONSTANTS ──────────────
-- Day one, the new system must agree with what checkout charges today, for BOTH
-- tracks independently. There is no live DB row to copy from (unlike pricing):
-- the current source of truth is hardcoded TypeScript, so these literals are the
-- transcription of it, and shipping-rates-mapping.test.ts parses the two VALUES
-- lists below and compares them against src/lib/pricing.ts's
-- DEFAULT_DOMESTIC_SHIPPING and src/lib/print-shipping.ts's
-- DEFAULT_INTERNATIONAL_SHIPPING, key, label AND value.
--
-- Values are stored as TEXT exactly as JS String() renders them (so '7.3', not
-- '7.30'): Field.value is a string on the wire, the CMS round-trips it
-- verbatim, and byte-identical values are what make the lockstep test an
-- equality check rather than a numeric-tolerance one. Trailing zeros carry no
-- numeric meaning, and every consumer parses with ::numeric / Number().
--
-- Both rows are created, seeded and stamped published in this one migration,
-- and therefore in one transaction — there is never a window in which a
-- shipping_rates row exists with no published revision behind it.
insert into shipping_rates (id) values ('domestic'), ('international');

with domestic_seed(key, label, value, ord) as (values
  ('paczkomat_pln', 'Paczkomat InPost (PLN)',   '20', 1),
  ('kurier_pln',    'Kurier InPost (PLN)',      '30', 2),
  ('odbior_pln',    'Odbiór w pracowni (PLN)',  '0',  3),
  ('paczkomat_eur', 'Paczkomat InPost (EUR)',   '5',  4),
  ('kurier_eur',    'Kurier InPost (EUR)',      '10', 5),
  ('odbior_eur',    'Odbiór w pracowni (EUR)',  '0',  6),
  ('paczkomat_gbp', 'Paczkomat InPost (GBP)',   '5',  7),
  ('kurier_gbp',    'Kurier InPost (GBP)',      '12', 8),
  ('odbior_gbp',    'Odbiór w pracowni (GBP)',  '0',  9)
)
insert into shipping_rate_drafts (rate_id, revision, payload, created_by)
select
  'domestic',
  1,
  jsonb_build_object('fields', (
    select jsonb_agg(
             jsonb_build_object(
               'key', s.key, 'label', s.label, 'type', 'number',
               'value', s.value, 'locale', 'none', 'sourceLocale', 'none'
             )
             order by s.ord
           )
      from domestic_seed s
  )),
  'migration:20260917150000_cms_api_shipping_rates';

-- 28 rows, one per destination, mirroring src/lib/print-shipping.ts's
-- SHIPPING_EUR table one-for-one (framed, loose). Each row seeds two fields.
with intl_seed(code, framed, loose, ord) as (values
  ('AT', '17.25',  '10.45', 1),
  ('BE', '12.95',  '10.45', 2),
  ('BG', '25.9',   '10.45', 3),
  ('HR', '25.9',   '10.45', 4),
  ('CY', '132.43', '10.45', 5),
  ('CZ', '17.25',  '10.45', 6),
  ('DK', '20.5',   '9.15',  7),
  ('EE', '32.35',  '11.62', 8),
  ('FI', '25.9',   '11.62', 9),
  ('FR', '16.15',  '9.15',  10),
  ('DE', '12.95',  '7.3',   11),
  ('GR', '25.9',   '10.45', 12),
  ('HU', '25.9',   '10.45', 13),
  ('IE', '18.35',  '10.25', 14),
  ('IT', '18.35',  '11.62', 15),
  ('LV', '31.3',   '10.45', 16),
  ('LT', '32.35',  '13.45', 17),
  ('LU', '15.1',   '10.45', 18),
  ('MT', '132.43', '10.45', 19),
  ('NL', '11.85',  '10.45', 20),
  ('PL', '18.35',  '10.45', 21),
  ('PT', '25.9',   '11.3',  22),
  ('RO', '23.75',  '10.45', 23),
  ('SK', '25.9',   '10.45', 24),
  ('SI', '25.9',   '10.45', 25),
  ('ES', '25.9',   '11.3',  26),
  ('SE', '19.4',   '10.45', 27),
  ('GB', '20.79',  '5.66',  28)
), intl_fields as (
  select
    jsonb_build_object(
      'key',   lower(s.code) || '_' || p.pack || '_eur',
      'label', 'Wysyłka ' || s.code || ' — ' || p.label_pl || ' (EUR)',
      'type',  'number',
      'value', case when p.pack = 'framed' then s.framed else s.loose end,
      'locale', 'none',
      'sourceLocale', 'none'
    ) as field,
    s.ord as country_ord,
    p.ord as pack_ord
    from intl_seed s
    cross join (values ('framed', 1, 'w ramie'), ('loose', 2, 'bez ramy')) as p(pack, ord, label_pl)
)
insert into shipping_rate_drafts (rate_id, revision, payload, created_by)
select
  'international',
  1,
  jsonb_build_object('fields', (
    select jsonb_agg(f.field order by f.country_ord, f.pack_ord) from intl_fields f
  )),
  'migration:20260917150000_cms_api_shipping_rates';

update shipping_rates r set published_revision = 1, published_at = now();

-- In-database lockstep guard: the payloads just seeded must carry exactly the
-- keys shipping_rate_field_keys() says are publishable, in that order. If they
-- ever disagree, the migration ABORTS rather than leaving a resource that is
-- marked published but could never be re-published through the RPC.
do $$
declare
  v_rate_id text;
  v_keys    text[];
begin
  foreach v_rate_id in array array['domestic', 'international'] loop
    select array_agg(t.f->>'key' order by t.ord)
      into v_keys
      from shipping_rate_drafts d
      cross join lateral jsonb_array_elements(d.payload->'fields') with ordinality as t(f, ord)
     where d.rate_id = v_rate_id
       and d.revision = 1;

    if v_keys is distinct from shipping_rate_field_keys(v_rate_id) then
      raise exception 'shipping_rate_backfill_key_mismatch'
        using detail = format('rateId=%s', v_rate_id);
    end if;
  end loop;
end $$;

-- Audit the backfill under each resource's own id as the catalog_audit_log
-- sentinel product_id — the same string the CMS uses as the resource id, so
-- GET /v1/audit?resourceId=domestic works with no special-casing (see
-- src/server/cms-api/handlers/audit.ts, whose resourceId sanitiser allows
-- [A-Za-z0-9_-] only, which both ids satisfy). Same posture as pricing's
-- 'print-pricing' sentinel. collection_id stays null, satisfying
-- catalog_audit_log_product_or_collection_check (num_nonnulls = 1).
insert into catalog_audit_log (product_id, actor_email, action, before, after, revision)
select d.rate_id, null, 'published', null, d.payload, 1
from shipping_rate_drafts d
where d.revision = 1;

-- 7. save_shipping_rate_draft ─────────────────────────────────────────────────
-- Mirrors save_collection_draft. The `for update` row lock is taken on this
-- resource's shipping_rates row — the same row publish_shipping_rate_revision
-- locks — so draft-revision allocation is serialized against every other write
-- to THIS resource (and only this one: the two tracks never block each other).
-- shipping_rate_drafts' unique (rate_id, revision) is the backstop if that lock
-- is ever bypassed.
--
-- No range checking happens here: a draft may hold any values at all (the
-- operator is mid-edit). Ranges are enforced at PUBLISH time only.
create or replace function save_shipping_rate_draft(
  p_rate_id           text,
  p_expected_revision integer,
  p_payload           jsonb,
  p_actor_email       text
) returns shipping_rate_drafts
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_current_revision integer;
  v_new_revision     integer;
  v_row              shipping_rate_drafts%rowtype;
  v_previous         jsonb;
begin
  perform 1 from shipping_rates r where r.id = p_rate_id for update;
  if not found then
    raise 'shipping_rate_not_found';
  end if;

  select coalesce(max(d.revision), 0)
    into v_current_revision
    from shipping_rate_drafts d
   where d.rate_id = p_rate_id;

  if v_current_revision <> p_expected_revision then
    raise 'revision_conflict' using detail = format('currentRevision=%s', v_current_revision);
  end if;

  select d.payload
    into v_previous
    from shipping_rate_drafts d
   where d.rate_id = p_rate_id
   order by d.revision desc
   limit 1;

  v_new_revision := v_current_revision + 1;

  insert into shipping_rate_drafts (rate_id, revision, payload, created_by)
  values (p_rate_id, v_new_revision, p_payload, p_actor_email)
  returning * into v_row;

  insert into catalog_audit_log (product_id, actor_email, action, before, after, revision)
  values (p_rate_id, p_actor_email, 'draft_saved', v_previous, p_payload, v_new_revision);

  return v_row;
end;
$$;

revoke all on function save_shipping_rate_draft(text, integer, jsonb, text) from public, anon, authenticated;
grant execute on function save_shipping_rate_draft(text, integer, jsonb, text) to service_role;

-- 8. publish_shipping_rate_revision ───────────────────────────────────────────
-- The only place shipping_rates.published_revision is written by the CmsApi,
-- and therefore the only place the values checkout charges actually move
-- (src/lib/shipping-rates/load.ts reads the draft this pointer names).
--
-- Transaction / locking discipline (modelled on publish_pricing_revision): the
-- resource's row is SELECT ... FOR UPDATE'd as the FIRST statement, before the
-- revision check, before parsing, before validation. Everything that follows
-- happens inside that one lock and one transaction (a plpgsql function invoked
-- as an RPC is a single statement, hence a single transaction), so a concurrent
-- publish of the SAME resource blocks rather than interleaving, and checkout —
-- which reads the row and its draft with plain, uncontended SELECTs — sees
-- either the whole old revision or the whole new one. The composite FK on
-- (id, published_revision) makes "published_revision points at a revision that
-- does not exist" unrepresentable.
--
-- Range validation (the plan's ">=0 for all values"):
--   - every key shipping_rate_field_keys(p_rate_id) names must be present and
--     be a plain decimal literal,
--   - value >= 0 — a negative shipping price would pay the customer to order,
--   - at most 2 decimal places. These are MAJOR currency units that checkout
--     turns into minor units (toMinor()'s round(v x 100) for domestic,
--     Math.ceil for international), so a third decimal would be silently
--     rounded away at charge time — the same class of silent-rounding hazard
--     publish_pricing_revision's numeric(8,4) scale check closes. The test is
--     `v * 100 = trunc(v * 100)` on exact numerics, NOT scale(v) <= 2, so it is
--     trailing-zero agnostic ('7.30' and '7.3' are both accepted, both being
--     exactly 7.3) and cannot disagree with the TypeScript side.
-- Every rule is restated once in src/server/cms-api/shipping-rates-validation.ts
-- for per-field error messages; this copy is the enforcement.
--
-- Error detail format (invalidKeys=<comma-joined keys>) is the same convention
-- as publish_pricing_revision's pricing_invalid and publish_collection_revision's
-- product_ref_invalid / invalidIds=.
create or replace function publish_shipping_rate_revision(
  p_rate_id           text,
  p_expected_revision integer,
  p_actor_email       text
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_current_revision integer;
  v_rate             shipping_rates%rowtype;
  v_payload          jsonb;
  v_values           jsonb;
  v_before           jsonb;
  v_after            jsonb;
  v_key              text;
  v_text             text;
  v_num              numeric;
  v_invalid          text[] := array[]::text[];
begin
  select * into v_rate from shipping_rates r where r.id = p_rate_id for update;
  if not found then
    raise 'shipping_rate_not_found';
  end if;

  select coalesce(max(d.revision), 0)
    into v_current_revision
    from shipping_rate_drafts d
   where d.rate_id = p_rate_id;

  if v_current_revision <> p_expected_revision then
    raise 'revision_conflict' using detail = format('currentRevision=%s', v_current_revision);
  end if;

  -- revision 0 means "no draft has ever been saved" (shipping_rate_drafts.revision
  -- starts at 1). The backfill above makes this unreachable in practice; kept so
  -- publishing at 0 is a clear 4xx rather than an unmapped FK violation, exactly
  -- as in publish_collection_revision / publish_pricing_revision.
  if p_expected_revision = 0 then
    raise 'draft_required';
  end if;

  select d.payload
    into v_payload
    from shipping_rate_drafts d
   where d.rate_id = p_rate_id
     and d.revision = p_expected_revision;

  if v_payload is null then
    raise 'draft_required';
  end if;

  v_values := shipping_rate_draft_values(v_payload);

  foreach v_key in array shipping_rate_field_keys(p_rate_id) loop
    v_text := btrim(coalesce(v_values->>v_key, ''));
    if v_text !~ '^-?[0-9]+(\.[0-9]+)?$' then
      -- absent, blank, or not a plain decimal literal.
      v_invalid := array_append(v_invalid, v_key);
    else
      v_num := v_text::numeric;
      if v_num < 0 or v_num * 100 <> trunc(v_num * 100) then
        v_invalid := array_append(v_invalid, v_key);
      end if;
    end if;
  end loop;

  if array_length(v_invalid, 1) is not null then
    raise exception 'shipping_rates_invalid' using detail = format('invalidKeys=%s', array_to_string(v_invalid, ','));
  end if;

  v_before := to_jsonb(v_rate);

  update shipping_rates r set
    published_revision = p_expected_revision,
    published_at       = coalesce(r.published_at, now()),
    updated_at         = now()
  where r.id = p_rate_id;

  select * into v_rate from shipping_rates r where r.id = p_rate_id;
  v_after := to_jsonb(v_rate);

  insert into catalog_audit_log (product_id, actor_email, action, before, after, revision)
  values (p_rate_id, p_actor_email, 'published', v_before, v_after, p_expected_revision);

  return jsonb_build_object('ok', true, 'shippingRate', v_after);
end;
$$;

revoke all on function publish_shipping_rate_revision(text, integer, text) from public, anon, authenticated;
grant execute on function publish_shipping_rate_revision(text, integer, text) to service_role;

-- 9. restore_shipping_rate_draft ──────────────────────────────────────────────
-- Mirrors restore_collection_draft / restore_pricing_draft: re-saves an old
-- revision's payload as a brand-new revision (current max + 1). Nothing is
-- deleted or rewritten, and published_revision is NEVER touched — restoring an
-- old draft does not publish it, so checkout keeps charging the currently
-- published revision until an explicit publish call.
create or replace function restore_shipping_rate_draft(
  p_rate_id           text,
  p_expected_revision integer,
  p_source_revision   integer,
  p_actor_email       text
) returns shipping_rate_drafts
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_current_revision integer;
  v_new_revision     integer;
  v_source_payload   jsonb;
  v_previous         jsonb;
  v_row              shipping_rate_drafts%rowtype;
begin
  perform 1 from shipping_rates r where r.id = p_rate_id for update;
  if not found then
    raise 'shipping_rate_not_found';
  end if;

  select coalesce(max(d.revision), 0)
    into v_current_revision
    from shipping_rate_drafts d
   where d.rate_id = p_rate_id;

  if v_current_revision <> p_expected_revision then
    raise 'revision_conflict' using detail = format('currentRevision=%s', v_current_revision);
  end if;

  select d.payload
    into v_source_payload
    from shipping_rate_drafts d
   where d.rate_id = p_rate_id
     and d.revision = p_source_revision;

  if v_source_payload is null then
    raise 'source_revision_not_found';
  end if;

  select d.payload
    into v_previous
    from shipping_rate_drafts d
   where d.rate_id = p_rate_id
   order by d.revision desc
   limit 1;

  v_new_revision := v_current_revision + 1;

  insert into shipping_rate_drafts (rate_id, revision, payload, created_by)
  values (p_rate_id, v_new_revision, v_source_payload, p_actor_email)
  returning * into v_row;

  insert into catalog_audit_log (product_id, actor_email, action, before, after, revision)
  values (p_rate_id, p_actor_email, 'restored', v_previous, v_source_payload, v_new_revision);

  return v_row;
end;
$$;

revoke all on function restore_shipping_rate_draft(text, integer, integer, text) from public, anon, authenticated;
grant execute on function restore_shipping_rate_draft(text, integer, integer, text) to service_role;

-- ============================================================
-- Rollback (manual):
--   drop function if exists restore_shipping_rate_draft(text, integer, integer, text);
--   drop function if exists publish_shipping_rate_revision(text, integer, text);
--   drop function if exists save_shipping_rate_draft(text, integer, jsonb, text);
--   drop function if exists shipping_rate_draft_values(jsonb);
--   drop function if exists shipping_rate_field_keys(text);
--   delete from catalog_audit_log where product_id in ('domestic', 'international');
--   alter table shipping_rates drop constraint if exists shipping_rates_published_revision_fk;
--   alter table shipping_rates drop column if exists published_revision;
--   drop table if exists shipping_rate_drafts;
--   drop table if exists shipping_rates;
-- NOTE: rolling back also requires reverting src/app/api/checkout/route.ts to
-- the code constants — the cutover is one deploy in each direction.
-- ============================================================
